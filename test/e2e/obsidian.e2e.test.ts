/**
 * End-to-end test: runs the built plugin inside the real Obsidian desktop app
 * against the Azurite storage emulator, with a simulated second device.
 *
 *   npm run build
 *   OBSIDIAN_BIN=/path/to/obsidian npm run test:e2e
 *
 * (On Linux extract the AppImage with --appimage-extract and point
 * OBSIDIAN_BIN at squashfs-root/obsidian; Xvfb is used when there is no display.)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureBlobClient } from "../../src/azure/client";
import { resolveConnection } from "../../src/azure/sas";
import { AzureRemoteStore } from "../../src/sync/azure-remote";
import { DEFAULT_ENGINE_OPTIONS, SyncEngine } from "../../src/sync/engine";
import { createPathFilter } from "../../src/sync/filter";
import { emptyState } from "../../src/sync/types";
import { fetchHttp, nodeSleep, startAzurite, type Azurite } from "../helpers/azurite";
import { Clock, MemoryLocalFs, dec } from "../helpers/memory";
import { Cdp, launchObsidian, sleep, waitFor, type ObsidianInstance } from "../helpers/obsidian";

const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN;
const OUT_DIR = process.env.E2E_OUT_DIR ?? join(tmpdir(), "azure-blob-sync-e2e");
const CONTAINER = "obsidian-e2e";
const PREFIX = "vaults/e2e";
const PLUGIN = "azure-blob-sync";

describe.skipIf(!OBSIDIAN_BIN)("Obsidian end-to-end", { timeout: 90_000 }, () => {
	let azurite: Azurite;
	let obsidian: ObsidianInstance;
	let remote: AzureBlobClient;
	let sas: string;
	const vault = join(OUT_DIR, "vault");
	const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN);
	const phone = (() => {
		const clock = new Clock(Date.now() - 86_400_000);
		return { clock, fs: new MemoryLocalFs(clock), engine: undefined as unknown as SyncEngine };
	})();

	const blob = async (path: string): Promise<string | undefined> => {
		try {
			return dec((await remote.getBlob(`${PREFIX}/${path}`)).data);
		} catch {
			return undefined;
		}
	};
	const remotePaths = async () =>
		(await remote.listBlobs(`${PREFIX}/`)).map((b) => b.name.slice(PREFIX.length + 1)).sort();
	const disk = (path: string): string | undefined =>
		existsSync(join(vault, path)) ? readFileSync(join(vault, path), "utf8") : undefined;
	const ev = <T = unknown>(code: string) => obsidian.cdp.eval<T>(code);

	beforeAll(async () => {
		rmSync(OUT_DIR, { recursive: true, force: true });
		mkdirSync(pluginDir, { recursive: true });
		azurite = await startAzurite();
		sas = await azurite.createContainer(CONTAINER);
		remote = new AzureBlobClient(
			resolveConnection({
				accountName: "",
				containerName: CONTAINER,
				sasToken: sas,
				serviceUrl: azurite.serviceUrl,
				remotePrefix: "",
			}),
			fetchHttp,
			{ sleep: nodeSleep },
		);

		// The "phone": a second device running the same sync engine.
		phone.engine = new SyncEngine(
			phone.fs,
			new AzureRemoteStore(
				new AzureBlobClient(
					resolveConnection({
						accountName: "",
						containerName: CONTAINER,
						sasToken: sas,
						serviceUrl: azurite.serviceUrl,
						remotePrefix: PREFIX,
					}),
					fetchHttp,
					{ sleep: nodeSleep },
				),
			),
			emptyState("phone"),
			{
				...DEFAULT_ENGINE_OPTIONS,
				isSyncable: createPathFilter({
					configDir: ".obsidian",
					pluginDir: `.obsidian/plugins/${PLUGIN}`,
					syncConfigDir: false,
					ignorePatterns: [],
				}),
			},
			async () => {},
		);
		phone.fs.set("From phone.md", "written on the phone");
		phone.fs.set("Shared/Doc.md", "shared doc");
		const seeded = await phone.engine.fullSync();
		expect(seeded.uploaded).toHaveLength(2);

		// The desktop vault, with the built plugin installed and configured.
		writeFileSync(join(vault, "Local note.md"), "# Local\nwritten on the desktop");
		mkdirSync(join(vault, "Folder"), { recursive: true });
		writeFileSync(join(vault, "Folder", "Nested.md"), "nested");
		writeFileSync(join(vault, "empty.md"), "");
		writeFileSync(join(vault, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]));
		for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(pluginDir, f));
		writeFileSync(
			join(pluginDir, "data.json"),
			JSON.stringify({
				accountName: "",
				containerName: CONTAINER,
				sasToken: sas,
				serviceUrl: azurite.serviceUrl,
				remotePrefix: PREFIX,
				liveSync: true,
				syncOnStartup: true,
				pushDelaySeconds: 1,
				pollIntervalSeconds: 2,
			}),
		);
		writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([PLUGIN]));

		obsidian = await launchObsidian({
			binary: OBSIDIAN_BIN!,
			home: join(OUT_DIR, "home"),
			vaultPath: vault,
			port: 9300 + Math.floor(Math.random() * 500),
			logFile: join(OUT_DIR, "obsidian.log"),
		});
		await waitFor("workspace ready", () => ev<boolean>("return app.workspace.layoutReady"), 60_000);
		// First open of a vault with plugins: accept the trust prompt like a user would.
		const trusted = await ev<boolean>(`
			const btn = [...document.querySelectorAll('.modal button')].find(b => /trust/i.test(b.innerText));
			if (btn) { btn.click(); return true; }
			return false;`);
		if (!trusted) await ev("await app.plugins.setEnable(true);");
		await waitFor("plugin loaded", () => ev<boolean>(`return !!app.plugins.plugins['${PLUGIN}']`), 30_000);
	}, 120_000);

	afterAll(async () => {
		if (obsidian) {
			try {
				const log = await ev<string[]>(`return app.plugins.plugins['${PLUGIN}']?.logLines ?? []`);
				writeFileSync(join(OUT_DIR, "plugin.log"), log.join("\n"));
			} catch {
				// window already gone
			}
			const errors = [...obsidian.cdp.exceptions, ...obsidian.cdp.consoleErrors];
			if (errors.length) console.log("Renderer errors:\n" + errors.join("\n"));
			await obsidian.stop();
		}
		await azurite?.stop();
	});

	it("runs the initial two-way sync on startup", async () => {
		await waitFor("local files uploaded", async () => {
			const paths = await remotePaths();
			return ["Folder/Nested.md", "Local note.md", "empty.md", "image.png"].every((p) => paths.includes(p));
		});
		await waitFor("remote files downloaded", async () => disk("From phone.md") === "written on the phone");
		expect(disk("Shared/Doc.md")).toBe("shared doc");
		expect(await blob("Local note.md")).toBe("# Local\nwritten on the desktop");
		expect((await remote.getBlob(`${PREFIX}/empty.md`)).data.byteLength).toBe(0);
		expect(Buffer.from((await remote.getBlob(`${PREFIX}/image.png`)).data)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]),
		);
		// The downloaded note keeps the phone's modification time
		const phoneMtime = phone.fs.files.get("From phone.md")!.mtime;
		expect(Math.abs(statSync(join(vault, "From phone.md")).mtimeMs - phoneMtime)).toBeLessThan(2000);
		// Obsidian indexed it
		expect(await ev<string>(`return await app.vault.read(app.vault.getFileByPath('From phone.md'))`)).toBe(
			"written on the phone",
		);
		// Device specific files never leave the device
		const paths = await remotePaths();
		expect(paths.some((p) => p.startsWith(".obsidian"))).toBe(false);
		expect(existsSync(join(pluginDir, "sync-state.json"))).toBe(true);
	});

	it("uploads edits, new files, renames and deletions made in Obsidian", async () => {
		await ev(`await app.vault.modify(app.vault.getFileByPath('Local note.md'), 'edited in Obsidian');`);
		await waitFor("edit uploaded", async () => (await blob("Local note.md")) === "edited in Obsidian");

		await ev(`await app.vault.create('Created in Obsidian.md', 'brand new');`);
		await waitFor("new file uploaded", async () => (await blob("Created in Obsidian.md")) === "brand new");

		await ev(`await app.vault.createFolder('Moved');
			await app.fileManager.renameFile(app.vault.getFileByPath('Created in Obsidian.md'), 'Moved/Renamed.md');`);
		await waitFor("rename propagated", async () => {
			const paths = await remotePaths();
			return paths.includes("Moved/Renamed.md") && !paths.includes("Created in Obsidian.md");
		});

		await ev(`await app.fileManager.renameFile(app.vault.getFolderByPath('Folder'), 'Folder Renamed');`);
		await waitFor("folder rename propagated", async () => {
			const paths = await remotePaths();
			return paths.includes("Folder Renamed/Nested.md") && !paths.includes("Folder/Nested.md");
		});

		await ev(`await app.fileManager.trashFile(app.vault.getFileByPath('Moved/Renamed.md'));`);
		await waitFor("deletion propagated", async () => !(await remotePaths()).includes("Moved/Renamed.md"));
	});

	it("pulls changes and deletions made on another device", async () => {
		const phoneSync = await phone.engine.fullSync();
		expect(phoneSync.errors).toEqual([]);
		expect(phone.fs.get("Local note.md")).toBe("edited in Obsidian");

		phone.fs.set("From phone.md", "edited on the phone");
		phone.fs.remove("Shared/Doc.md");
		phone.fs.set("Phone/New.md", "new from phone");
		const pushed = await phone.engine.pushPaths(["From phone.md", "Shared/Doc.md", "Phone/New.md"]);
		expect(pushed.errors).toEqual([]);

		await waitFor("remote edit pulled", async () => disk("From phone.md") === "edited on the phone");
		await waitFor("remote file pulled", async () => disk("Phone/New.md") === "new from phone");
		await waitFor("remote deletion applied", async () => !existsSync(join(vault, "Shared", "Doc.md")));
		// The folder emptied by the deletion is cleaned up too
		await waitFor("empty folder removed", async () => !existsSync(join(vault, "Shared")));
		expect(
			await ev<string>(`return await app.vault.cachedRead(app.vault.getFileByPath('From phone.md'))`),
		).toBe("edited on the phone");
	});

	it("keeps both versions when a file was edited on both devices", async () => {
		// Pause live sync so both sides change before the next sync.
		await ev(`const p = app.plugins.plugins['${PLUGIN}']; p.settings.liveSync = false; await p.saveSettings();`);
		await sleep(500);
		await ev(`await app.vault.modify(app.vault.getFileByPath('From phone.md'), 'desktop wins the race');`);
		await phone.engine.fullSync();
		phone.fs.set("From phone.md", "phone version of the race");
		await phone.engine.pushPaths(["From phone.md"]);

		await ev(`app.commands.executeCommandById('${PLUGIN}:sync-now');`);
		const copy = await waitFor("conflict copy created", async () =>
			ev<string | undefined>(`return app.vault.getFiles().map(f => f.path).find(p => p.startsWith('From phone (conflict'))`),
		);
		expect(disk(copy)).toBe("phone version of the race");
		expect(disk("From phone.md")).toBe("desktop wins the race");
		expect(await blob("From phone.md")).toBe("desktop wins the race");
		expect(await blob(copy)).toBe("phone version of the race");

		await ev(`const p = app.plugins.plugins['${PLUGIN}']; p.settings.liveSync = true; await p.saveSettings();`);
	});

	it("asks before applying a mass deletion from another device", async () => {
		await phone.engine.fullSync();
		const bulk = Array.from({ length: 14 }, (_, i) => `Bulk/note ${i}.md`);
		for (const p of bulk) phone.fs.set(p, `bulk ${p}`);
		await phone.engine.pushPaths(bulk);
		await waitFor("bulk files pulled", async () => bulk.every((p) => disk(p) !== undefined));

		for (const p of bulk) phone.fs.remove(p);
		const pushed = await phone.engine.pushPaths(bulk, { allowMassDelete: true });
		expect(pushed.deletedRemote).toHaveLength(14);

		// Read the dialog through the plugin: Obsidian opens modals in the active window,
		// which under Xvfb (no window manager) can be its hidden settings window.
		const modalText = await waitFor("confirmation dialog", () =>
			ev<string | undefined>(`return app.plugins.plugins['${PLUGIN}'].deletionModal?.containerEl.innerText`),
		);
		expect(modalText).toContain("14 file(s) from this device");
		// Held back: still on disk while the dialog is open
		expect(bulk.every((p) => disk(p) !== undefined)).toBe(true);

		const statusBar = () =>
			ev<string>(
				`return [...document.querySelectorAll('.status-bar-item')].map(e => e.innerText).find(t => t.startsWith('Azure'))`,
			);
		expect(await statusBar()).toBe("Azure: ⚠ 14 deletions on hold");

		// Closing the dialog postpones the decision: nothing is deleted or restored...
		await ev(`app.plugins.plugins['${PLUGIN}'].deletionModal.close();`);
		await sleep(5000); // a couple of poll cycles
		expect(bulk.every((p) => disk(p) !== undefined)).toBe(true);
		expect(await ev<boolean>(`return !app.plugins.plugins['${PLUGIN}'].deletionModal`)).toBe(true);
		expect(await statusBar()).toBe("Azure: ⚠ 14 deletions on hold");
		expect(await remotePaths()).not.toContain("Bulk/note 0.md");

		// ...and "Sync now" asks again.
		await ev(`app.commands.executeCommandById('${PLUGIN}:sync-now');`);
		await waitFor("dialog shown again", () =>
			ev<boolean>(`return !!app.plugins.plugins['${PLUGIN}'].deletionModal`),
		);
		await ev(
			`[...app.plugins.plugins['${PLUGIN}'].deletionModal.contentEl.querySelectorAll('button')].find(b => b.innerText === 'Delete files').click();`,
		);
		await waitFor("bulk deletion applied", async () => bulk.every((p) => disk(p) === undefined));
		await waitFor("bulk folder removed", async () => !existsSync(join(vault, "Bulk")));
		await waitFor("status cleared", async () => (await statusBar()).startsWith("Azure: ✓"));
	});

	it("is idle once everything is in sync", async () => {
		const result = await ev<{ up: number; down: number; del: number; delR: number; errors: unknown[] }>(`
			const r = await app.plugins.plugins['${PLUGIN}'].syncNow('manual');
			return { up: r.uploaded.length, down: r.downloaded.length, del: r.deletedLocal.length, delR: r.deletedRemote.length, errors: r.errors };`);
		expect(result).toEqual({ up: 0, down: 0, del: 0, delR: 0, errors: [] });
		const status = await ev<string>(
			`return [...document.querySelectorAll('.status-bar-item')].map(e => e.innerText).find(t => t.startsWith('Azure')) ?? ''`,
		);
		expect(status).toMatch(/^Azure: ✓ /);
	});

	it("keeps the SAS token out of data.json when secret storage is available", async () => {
		const hasSecretStorage = await ev<boolean>("return typeof app.secretStorage?.getSecret === 'function'");
		const data = JSON.parse(readFileSync(join(pluginDir, "data.json"), "utf8"));
		if (hasSecretStorage) {
			expect(data.sasToken).toBe("");
			expect(data.sasInSecretStorage).toBe(true);
			expect(await ev<string>(`return app.plugins.plugins['${PLUGIN}'].settings.sasToken`)).toBe(sas);
			// Survives a plugin reload
			await ev(`await app.plugins.disablePlugin('${PLUGIN}'); await app.plugins.enablePlugin('${PLUGIN}');`);
			await waitFor("plugin reloaded", () => ev<boolean>(`return !!app.plugins.plugins['${PLUGIN}']?.settings`));
			expect(await ev<string>(`return app.plugins.plugins['${PLUGIN}'].settings.sasToken`)).toBe(sas);
		} else {
			expect(data.sasToken).toBe(sas);
		}
	});

	it("renders the settings tab and the connection test succeeds", async () => {
		// Obsidian 1.14 opens settings in a popout window; query through app.setting.
		await ev(`app.setting.open(); app.setting.openTabById('${PLUGIN}');`);
		await waitFor("settings rendered", () =>
			ev<boolean>(`return !!app.setting.modalEl.querySelector('.azure-blob-sync-test-result')`),
		);
		const labels = await ev<string>(`return app.setting.modalEl.querySelector('.vertical-tab-content').innerText`);
		for (const label of ["Quick setup: paste a blob SAS URL", "Storage account name", "Container name", "SAS token", "Remote folder", "Live sync", "Ignore patterns"]) {
			expect(labels).toContain(label);
		}
		expect(labels).toMatch(/Permissions: racwdl/);

		// Obsidian 1.13+ renders the declarative definitions, which makes them searchable.
		const declarative = await ev<{ supported: boolean; groups: number }>(`
			const tab = app.setting.pluginTabs.find(t => t.id === '${PLUGIN}');
			return { supported: typeof tab.update === 'function', groups: (tab.settingItems ?? []).length };`);
		if (declarative.supported) {
			expect(declarative.groups).toBe(3);
			const found = await waitFor("settings search finds the plugin's settings", () =>
				ev<string | undefined>(`
					const input = app.setting.modalEl.querySelector('input[type="search"]');
					if (input.value !== 'remote folder') {
						input.value = 'remote folder';
						input.dispatchEvent(new Event('input', { bubbles: true }));
					}
					const text = app.setting.modalEl.innerText;
					return text.includes('Remote folder') && text.includes('Azure Blob Sync') ? text : undefined;`),
			);
			expect(found).toContain("Optional folder inside the container");
			await ev(`
				const input = app.setting.modalEl.querySelector('input[type="search"]');
				input.value = '';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				app.setting.openTabById('${PLUGIN}');`);
			await waitFor("settings tab shown again", () =>
				ev<boolean>(`return !!app.setting.modalEl.querySelector('.azure-blob-sync-test-result')`),
			);
		}
		await ev(
			`[...app.setting.modalEl.querySelectorAll('.vertical-tab-content button')].find(b => b.innerText === 'Test connection').click();`,
		);
		const text = await waitFor(
			"connection test finished",
			async () => {
				const t = await ev<string>(
					`return app.setting.modalEl.querySelector('.azure-blob-sync-test-result').innerText`,
				);
				return t.includes("Found") || t.includes("✗") ? t : undefined;
			},
			20_000,
		);
		expect(text).toContain("✓ Connected and listed the container");
		expect(text).toContain("✓ Write permission");
		expect(text).toContain("✓ Read permission");
		expect(text).toContain("✓ Delete permission");
		// The test blob is cleaned up and never synced
		expect((await remote.listBlobs("")).some((b) => b.name.includes("azure-blob-sync-test"))).toBe(false);

		// Screenshots of the settings window (its own window on 1.14+, a modal in the main window before).
		const settingsWindow = await Cdp.connect(obsidian.port, 10_000, (t) =>
			declarative.supported ? t.title.startsWith("Settings") : t.url.startsWith("app://obsidian.md/index.html"),
		);
		try {
			await settingsWindow.send("Emulation.setDeviceMetricsOverride", {
				width: 1000,
				height: 1400,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await sleep(500);
			writeFileSync(join(OUT_DIR, "settings.png"), await settingsWindow.screenshot());
			await ev(`app.setting.modalEl.querySelector('.vertical-tab-content').scrollTop = 1e6;`);
			await sleep(300);
			writeFileSync(join(OUT_DIR, "settings-2.png"), await settingsWindow.screenshot());
		} finally {
			settingsWindow.close();
		}
		await ev(`app.setting.close();`);
	});

	it("logged no errors in the Obsidian window", () => {
		const errors = [...obsidian.cdp.exceptions, ...obsidian.cdp.consoleErrors].filter((e) =>
			/azure|blob-sync/i.test(e),
		);
		expect(errors).toEqual([]);
	});
});
