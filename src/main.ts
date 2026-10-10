import { Notice, Platform, Plugin, TFolder, type TAbstractFile } from "obsidian";
import { AzureBlobClient } from "./azure/client";
import {
	connectionFingerprint,
	parseSasToken,
	resolveConnection,
	validateSasToken,
	type ResolvedConnection,
} from "./azure/sas";
import { ObsidianLocalFs } from "./obsidian/local-fs";
import { obsidianHttp } from "./obsidian/http";
import { DEFAULT_SETTINGS, type AzureSyncSettings } from "./settings";
import { AzureRemoteStore } from "./sync/azure-remote";
import { SyncController, type SyncStatus, type SyncTrigger } from "./sync/controller";
import { SyncEngine, errorMessage, type SyncEngineOptions } from "./sync/engine";
import { createPathFilter, parsePatterns } from "./sync/filter";
import { changeCount, emptyState, type SyncResult, type SyncState } from "./sync/types";
import { Mutex } from "./sync/util";
import { ConfirmDeletionModal, LogModal } from "./ui/modals";
import { AzureSyncSettingTab, describeTimeLeft } from "./ui/settings-tab";

const STATE_FILE = "sync-state.json";
const MAX_LOG_LINES = 500;

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
}

export default class AzureBlobSyncPlugin extends Plugin {
	settings: AzureSyncSettings = { ...DEFAULT_SETTINGS };
	private state: SyncState | null = null;
	private engine: SyncEngine | null = null;
	private engineKey = "";
	private readonly mutex = new Mutex();
	private controller!: SyncController;
	private statusBarEl: HTMLElement | null = null;
	private status: SyncStatus = { kind: "idle" };
	private pollHandle: number | null = null;
	private folderSyncHandle: number | null = null;
	private logLines: string[] = [];
	private lastNotifiedError = "";
	private deletionModal: ConfirmDeletionModal | null = null;
	private deletionPromptSnoozedUntil = 0;
	/** Deletions held back by the safety check in the last full sync. */
	private heldDeletions = 0;
	private lastFullSyncAt = 0;
	private ready = false;
	private settingTab: AzureSyncSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.controller = new SyncController({
			getEngine: () => this.getEngine(),
			pushDelayMs: () => this.settings.pushDelaySeconds * 1000,
			onStatus: (s) => this.setStatus(s),
			onResult: (r, t) => this.handleResult(r, t),
			onError: (e, t) => this.handleError(e, t),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable");
		this.statusBarEl.addEventListener("click", () => void this.syncNow("manual"));
		this.updateStatusBar();

		this.settingTab = new AzureSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon("refresh-cw", "Sync with Azure", () => void this.syncNow("manual"));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow("manual"),
		});
		this.addCommand({
			id: "toggle-live-sync",
			name: "Toggle live sync",
			callback: async () => {
				this.settings.liveSync = !this.settings.liveSync;
				await this.saveSettings();
				this.notify(`live sync ${this.settings.liveSync ? "on" : "off"}`);
				if (this.settings.liveSync) void this.syncNow("manual");
			},
		});
		this.addCommand({
			id: "show-log",
			name: "Show sync log",
			callback: () => this.showLog(),
		});
		this.addCommand({
			id: "reset-sync-state",
			name: "Reset sync state (compare all files on next sync)",
			callback: async () => {
				await this.resetSyncState();
				this.notify("sync state reset");
			},
		});

		this.app.workspace.onLayoutReady(async () => {
			await this.loadState();
			this.ready = true;
			this.registerVaultEvents();
			this.registerDomEvent(document, "visibilitychange", () => {
				if (!this.settings.liveSync) return;
				if (document.visibilityState === "visible") {
					if (Date.now() - this.lastFullSyncAt > 10_000) void this.controller.requestFullSync("focus");
				} else {
					// Mobile apps may be suspended in the background: upload now.
					void this.controller.flush();
				}
			});
			this.registerDomEvent(window, "online", () => {
				if (this.settings.liveSync) void this.controller.requestFullSync("focus");
			});
			this.restartPolling();
			this.updateStatusBar();
			this.warnIfSasExpiresSoon();
			if (this.settings.liveSync && this.settings.syncOnStartup) {
				void this.controller.requestFullSync("startup");
			}
		});
	}

	onunload(): void {
		this.deletionModal?.close();
		if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
		if (this.folderSyncHandle !== null) window.clearTimeout(this.folderSyncHandle);
		void this.controller?.flush();
		this.controller?.dispose();
	}

	// ------------------------------------------------------------------ settings

	private get secretStorage(): SecretStorageLike | null {
		const ss = (this.app as unknown as { secretStorage?: Partial<SecretStorageLike> }).secretStorage;
		if (ss && typeof ss.getSecret === "function" && typeof ss.setSecret === "function") {
			return ss as SecretStorageLike;
		}
		return null;
	}

	get usesSecretStorage(): boolean {
		return this.secretStorage !== null;
	}

	private secretId(): string {
		const vault = this.app.vault
			.getName()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		return `azure-blob-sync-sas${vault ? "-" + vault : ""}`;
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<AzureSyncSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
		if (this.settings.sasInSecretStorage) {
			let secret: string | null = null;
			try {
				secret = this.secretStorage?.getSecret(this.secretId()) ?? null;
			} catch (e) {
				this.log(`Could not read SAS token from secret storage: ${errorMessage(e)}`);
			}
			this.settings.sasToken = secret ?? "";
		}
	}

	async saveSettings(): Promise<void> {
		const toSave: AzureSyncSettings = { ...this.settings };
		const ss = this.secretStorage;
		toSave.sasInSecretStorage = false;
		if (ss) {
			try {
				ss.setSecret(this.secretId(), this.settings.sasToken);
				toSave.sasToken = "";
				toSave.sasInSecretStorage = true;
			} catch (e) {
				this.log(`Could not store SAS token in secret storage: ${errorMessage(e)}`);
			}
		}
		this.settings.sasInSecretStorage = toSave.sasInSecretStorage;
		await this.saveData(toSave);
		this.restartPolling();
		this.updateStatusBar();
	}

	// ------------------------------------------------------------------ state

	private get pluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	private get statePath(): string {
		return `${this.pluginDir}/${STATE_FILE}`;
	}

	private async loadState(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.statePath)) {
				const parsed = JSON.parse(await adapter.read(this.statePath)) as SyncState;
				if (parsed && parsed.version === 1 && typeof parsed.files === "object") {
					this.state = parsed;
					return;
				}
			}
		} catch (e) {
			this.log(`Could not read sync state, starting fresh: ${errorMessage(e)}`);
		}
		this.state = emptyState("");
	}

	private async saveState(state: SyncState): Promise<void> {
		// An engine for a previous target may still be finishing; never let it overwrite the current state.
		if (state !== this.state) return;
		await this.app.vault.adapter.write(this.statePath, JSON.stringify(state));
	}

	async resetSyncState(): Promise<void> {
		await this.mutex.run(async () => {
			if (!this.state) return;
			this.state = emptyState(this.state.target);
			this.engine = null;
			this.engineKey = "";
			await this.saveState(this.state);
		});
	}

	// ------------------------------------------------------------------ engine

	private engineOptions(): SyncEngineOptions {
		const configDir = this.app.vault.configDir;
		const strategy = this.settings.conflictStrategy;
		return {
			direction: this.settings.direction,
			conflictStrategy: strategy,
			// Conflict copies of settings files would only clutter the config folder.
			conflictStrategyFor: (path) =>
				strategy === "keep-both" && path.startsWith(configDir + "/") ? "newest-wins" : undefined,
			isSyncable: createPathFilter({
				configDir,
				pluginDir: this.pluginDir,
				syncConfigDir: this.settings.syncConfigDir,
				ignorePatterns: parsePatterns(this.settings.ignorePatterns),
			}),
			maxFileSize: Math.max(0, this.settings.maxFileSizeMB) * 1024 * 1024,
			concurrency: Platform.isMobile ? 2 : 4,
			massDeleteMinCount: 10,
			massDeleteRatio: 0.5,
			log: (m) => this.log(m),
		};
	}

	private resolve(): ResolvedConnection {
		const conn = resolveConnection(this.settings);
		const info = parseSasToken(conn.sasToken);
		if (!info.hasSignature) throw new Error('SAS token has no signature ("sig=" is missing).');
		if (info.expiry && info.expiry.getTime() <= Date.now()) {
			throw new Error(`SAS token expired on ${info.expiry.toLocaleString()}. Generate a new one.`);
		}
		return conn;
	}

	private getEngine(): SyncEngine | { error: string } {
		if (!this.ready || !this.state) return { error: "Obsidian is still starting." };
		let conn: ResolvedConnection;
		try {
			conn = this.resolve();
		} catch (e) {
			return { error: errorMessage(e) };
		}
		const target = connectionFingerprint(conn);
		if (this.state.target !== target) {
			if (this.state.target) this.log(`Sync target changed to ${target}; starting with a fresh sync state.`);
			this.state = emptyState(target);
			this.engine = null;
		}
		const key = JSON.stringify(conn);
		const options = this.engineOptions();
		if (!this.engine || this.engineKey !== key) {
			const client = new AzureBlobClient(conn, obsidianHttp);
			const localFs = new ObsidianLocalFs(this.app, {
				includeConfigDir: () => this.settings.syncConfigDir,
				skipFolder: (p) => p === this.pluginDir,
			});
			const state = this.state;
			this.engine = new SyncEngine(
				localFs,
				new AzureRemoteStore(client),
				state,
				options,
				(s) => this.saveState(s),
				this.mutex,
			);
			this.engineKey = key;
		} else {
			this.engine.updateOptions(options);
		}
		return this.engine;
	}

	// ------------------------------------------------------------------ triggers

	private registerVaultEvents(): void {
		const onChange = (file: TAbstractFile, path: string = file.path) => {
			if (!this.settings.liveSync || this.settings.direction === "download-only") return;
			if (file instanceof TFolder) {
				// Folder operations: let a full sync work out what moved.
				if (this.folderSyncHandle !== null) window.clearTimeout(this.folderSyncHandle);
				this.folderSyncHandle = window.setTimeout(() => {
					this.folderSyncHandle = null;
					void this.controller.requestFullSync("folder");
				}, this.settings.pushDelaySeconds * 1000);
				return;
			}
			this.controller.notifyChange(path);
		};
		this.registerEvent(this.app.vault.on("create", (f) => onChange(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => onChange(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onChange(f)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				onChange(f);
				if (!(f instanceof TFolder)) onChange(f, oldPath);
			}),
		);
	}

	private restartPolling(): void {
		if (this.pollHandle !== null) {
			window.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
		if (!this.ready || !this.settings.liveSync || this.settings.pollIntervalSeconds <= 0) return;
		this.pollHandle = window.setInterval(
			() => void this.controller.requestFullSync("poll"),
			this.settings.pollIntervalSeconds * 1000,
		);
		this.registerInterval(this.pollHandle);
	}

	async syncNow(trigger: SyncTrigger = "manual"): Promise<SyncResult | null> {
		if (!this.ready) {
			this.notify("Obsidian is still loading, try again in a moment.");
			return null;
		}
		const engine = this.getEngine();
		if ("error" in engine) {
			this.notify(engine.error);
			this.setStatus({ kind: "unconfigured", message: engine.error });
			return null;
		}
		await this.controller.flush();
		return this.controller.requestFullSync(trigger);
	}

	// ------------------------------------------------------------------ results & status

	private handleResult(result: SyncResult, trigger: SyncTrigger): void {
		if (trigger !== "push") this.lastFullSyncAt = Date.now();
		const changes = changeCount(result);
		if (changes > 0 || result.errors.length || trigger === "manual") {
			this.log(
				`[${trigger}] ↑${result.uploaded.length} ↓${result.downloaded.length} ` +
					`deleted here ${result.deletedLocal.length}, deleted in Azure ${result.deletedRemote.length}, ` +
					`conflicts ${result.conflicts.length}, errors ${result.errors.length}`,
			);
		}
		for (const s of result.skipped) this.log(`Skipped ${s.path}: ${s.reason}`);
		for (const e of result.errors) this.log(`Error ${e.path}: ${e.message}`);

		for (const c of result.conflicts) {
			if (c.resolution === "kept-both") {
				this.notify(
					`"${c.path}" was changed on this and another device. ` +
						`The other version was saved as "${c.conflictCopy}".`,
					15000,
				);
			} else if (c.resolution === "local" || c.resolution === "remote") {
				this.log(`Conflict on ${c.path}: kept the ${c.resolution === "local" ? "local" : "Azure"} version`);
			}
		}

		if (result.errors.length) {
			const msg = `${result.errors.length} file(s) failed to sync. ${result.errors[0].path}: ${result.errors[0].message}`;
			this.notifyError(msg, trigger === "manual");
		} else {
			this.lastNotifiedError = "";
		}

		const blocked = result.blockedDeletions;
		const held = blocked.local.length + blocked.remote.length;
		if (trigger !== "push") this.heldDeletions = held;
		if (held && (trigger === "manual" || Date.now() >= this.deletionPromptSnoozedUntil)) {
			this.confirmDeletions(blocked.local, blocked.remote);
		}

		if (trigger === "manual") {
			this.notify(
				changes > 0
					? summary(result)
					: result.errors.length
						? "finished with errors (see log)"
						: "everything is up to date",
			);
		} else if (changes > 0 && this.settings.notifyOnChanges) {
			this.notify(summary(result));
		}
	}

	private confirmDeletions(local: string[], remote: string[]): void {
		if (this.deletionModal) return;
		this.deletionModal = new ConfirmDeletionModal(this.app, local, remote, (decision) => {
			this.deletionModal = null;
			if (decision === "delete") {
				this.deletionPromptSnoozedUntil = 0;
				void this.controller.requestFullSync("manual", { allowMassDelete: true });
			} else if (decision === "keep") {
				this.deletionPromptSnoozedUntil = 0;
				const engine = this.getEngine();
				if ("error" in engine) return;
				this.log(`Keeping ${local.length + remote.length} file(s) a sync wanted to delete; restoring them.`);
				void engine.forgetPaths([...local, ...remote]).then(() => this.controller.requestFullSync("manual"));
			} else {
				// Decide later: keep holding the deletions, ask again on the next manual sync or in a while.
				this.deletionPromptSnoozedUntil = Date.now() + 10 * 60_000;
				this.updateStatusBar();
			}
		});
		this.deletionModal.open();
	}

	private handleError(error: unknown, trigger: SyncTrigger): void {
		const message = errorMessage(error);
		this.log(`[${trigger}] ${message}`);
		this.notifyError(message, trigger === "manual");
	}

	/** Shows a notice prefixed with the plugin name. */
	private notify(message: string, timeout?: number): void {
		new Notice(`${this.manifest.name}: ${message}`, timeout);
	}

	private notifyError(message: string, force: boolean): void {
		if (!force && message === this.lastNotifiedError) return;
		this.lastNotifiedError = message;
		this.notify(message, 10000);
	}

	private setStatus(status: SyncStatus): void {
		this.status = status;
		this.updateStatusBar();
		this.settingTab?.updateStatus();
	}

	statusText(): string {
		const s = this.status;
		switch (s.kind) {
			case "syncing":
				return "Syncing…";
			case "error":
				return `Last sync failed: ${s.message}`;
			case "unconfigured":
				return `Not syncing: ${s.message}`;
			case "idle":
				if (this.heldDeletions) {
					return `${this.heldDeletions} deletion(s) are on hold for your review. Run "Sync now" to review them.`;
				}
				if (s.lastSync) return `Last synced at ${s.lastSync.toLocaleTimeString()}`;
				return this.settings.liveSync ? "Live sync is on" : "Live sync is off";
		}
	}

	private updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const s = this.status;
		let text: string;
		if (s.kind === "syncing") text = "Azure: syncing…";
		else if (s.kind === "error") text = "Azure: ⚠ error";
		else if (s.kind === "unconfigured") text = "Azure: not configured";
		else if (this.heldDeletions) text = `Azure: ⚠ ${this.heldDeletions} deletions on hold`;
		else if (!this.settings.liveSync) text = s.lastSync ? `Azure: off (✓ ${hhmm(s.lastSync)})` : "Azure: off";
		else text = s.lastSync ? `Azure: ✓ ${hhmm(s.lastSync)}` : "Azure: live";
		el.setText(text);
		el.setAttribute("aria-label", `${this.statusText()}\nClick to sync now`);
		el.setAttribute("data-tooltip-position", "top");
	}

	log(message: string): void {
		const line = `${new Date().toLocaleTimeString()}  ${message}`;
		this.logLines.push(line);
		if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
	}

	showLog(): void {
		new LogModal(this.app, [...this.logLines]).open();
	}

	private warnIfSasExpiresSoon(): void {
		if (!this.settings.sasToken) return;
		const expiry = parseSasToken(this.settings.sasToken).expiry;
		if (!expiry) return;
		const left = expiry.getTime() - Date.now();
		if (left <= 0) {
			this.notify("your SAS token has expired. Generate a new one and paste it in the plugin settings.", 0);
		} else if (left < 7 * 86_400_000) {
			this.notify(
				`your SAS token expires in ${describeTimeLeft(left)}. Generate a new one in the Azure portal before it stops syncing.`,
				15000,
			);
		}
	}

	// ------------------------------------------------------------------ connection test

	async testConnection(): Promise<string[]> {
		const conn = resolveConnection(this.settings);
		const lines: string[] = [];
		for (const problem of validateSasToken(conn.sasToken)) lines.push(`⚠ ${problem}`);
		const client = new AzureBlobClient(conn, obsidianHttp, { retries: 0 });
		await client.probe(conn.prefix);
		lines.push("✓ Connected and listed the container");
		const name = `${conn.prefix}.azure-blob-sync-test-${Date.now().toString(36)}`;
		const payload = new TextEncoder().encode("azure-blob-sync connection test").buffer;
		await client.putBlob(name, payload, { contentType: "text/plain" });
		lines.push("✓ Write permission");
		const { data } = await client.getBlob(name);
		if (data.byteLength !== payload.byteLength) throw new Error("Read back different data than written.");
		lines.push("✓ Read permission");
		await client.deleteBlob(name);
		lines.push("✓ Delete permission");
		const files = await new AzureRemoteStore(client).list();
		lines.push(
			`Found ${files.length} file(s) in ${conn.containerName}${conn.prefix ? "/" + conn.prefix.slice(0, -1) : ""}. ` +
				(this.settings.liveSync ? "Live sync is on." : "Turn on live sync below to start syncing."),
		);
		return lines;
	}
}

function hhmm(d: Date): string {
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summary(r: SyncResult): string {
	const parts: string[] = [];
	if (r.uploaded.length) parts.push(`${r.uploaded.length} uploaded`);
	if (r.downloaded.length) parts.push(`${r.downloaded.length} downloaded`);
	if (r.deletedLocal.length) parts.push(`${r.deletedLocal.length} deleted here`);
	if (r.deletedRemote.length) parts.push(`${r.deletedRemote.length} deleted in Azure`);
	const conflicts = r.conflicts.filter((c) => c.resolution !== "identical").length;
	if (conflicts) parts.push(`${conflicts} conflict(s)`);
	return parts.join(", ") || "no changes";
}
