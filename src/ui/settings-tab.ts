import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { parseSasToken, parseSasUrl, validateSasToken } from "../azure/sas";
import type AzureBlobSyncPlugin from "../main";
import { CONFLICT_LABELS, DIRECTION_LABELS } from "../settings";
import type { ConflictStrategy, SyncDirection } from "../sync/types";

export function describeTimeLeft(ms: number): string {
	if (ms <= 0) return "";
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 1) return "less than an hour";
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.floor(hours / 24)} days`;
}

export class AzureSyncSettingTab extends PluginSettingTab {
	private sasInfoEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: AzureBlobSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		// ---------------------------------------------------------------- Connection
		new Setting(containerEl).setName("Connection").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Connect to your own Azure Storage container with a SAS token. In the Azure portal open your " +
				"storage account → Containers → your container → Shared access tokens, tick Read, Write, Delete " +
				"and List, choose an expiry date and click \"Generate SAS token and URL\".",
		});

		let sasUrlInput = "";
		new Setting(containerEl)
			.setName("Quick setup: paste a Blob SAS URL")
			.setDesc(
				"Paste the full \"Blob SAS URL\" (https://<account>.blob.core.windows.net/<container>?sv=…) to fill in the fields below.",
			)
			.addText((text) => {
				text.setPlaceholder("https://account.blob.core.windows.net/container?sv=…&sig=…").onChange((v) => {
					sasUrlInput = v;
				});
				text.inputEl.addClass("azure-blob-sync-wide");
			})
			.addButton((b) =>
				b.setButtonText("Fill in").onClick(async () => {
					try {
						const parsed = parseSasUrl(sasUrlInput);
						if (!parsed.sasToken) throw new Error("The URL has no SAS token (the part after \"?\").");
						Object.assign(settings, parsed);
						await this.plugin.saveSettings();
						const missing = parsed.containerName ? "" : " Enter the container name.";
						new Notice(`Connection details filled in.${missing}`);
						this.display();
					} catch (e) {
						new Notice(e instanceof Error ? e.message : String(e));
					}
				}),
			);

		new Setting(containerEl)
			.setName("Storage account name")
			.setDesc("The name of your storage account, e.g. \"mystorageaccount\".")
			.addText((text) =>
				text
					.setPlaceholder("mystorageaccount")
					.setValue(settings.accountName)
					.onChange(async (v) => {
						settings.accountName = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Container name")
			.setDesc("The blob container that stores the vault. It must already exist.")
			.addText((text) =>
				text
					.setPlaceholder("obsidian")
					.setValue(settings.containerName)
					.onChange(async (v) => {
						settings.containerName = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		const sasSetting = new Setting(containerEl)
			.setName("SAS token")
			.setDesc(
				this.plugin.usesSecretStorage
					? "The SAS token (sv=…&sig=…). Stored in Obsidian's secret storage on this device, not in the plugin's data file."
					: "The SAS token (sv=…&sig=…). Stored in this plugin's data file inside the vault's config folder.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.addClass("azure-blob-sync-wide");
				text
					.setPlaceholder("sv=2022-11-02&ss=b&srt=co&sp=rwdlac&se=…&sig=…")
					.setValue(settings.sasToken)
					.onChange(async (v) => {
						settings.sasToken = v.trim().replace(/^\?/, "");
						await this.plugin.saveSettings();
						this.renderSasInfo();
					});
			});
		this.sasInfoEl = sasSetting.descEl.createDiv({ cls: "azure-blob-sync-sas-info" });
		this.renderSasInfo();

		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc(
				"Optional folder inside the container for this vault, e.g. \"vaults/personal\". Leave empty to use the container root. Lets several vaults share one container.",
			)
			.addText((text) =>
				text
					.setPlaceholder("(container root)")
					.setValue(settings.remotePrefix)
					.onChange(async (v) => {
						settings.remotePrefix = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Blob service URL (advanced)")
			.setDesc(
				"Leave empty for normal Azure accounts. Set it for sovereign clouds, custom domains, private endpoints or the Azurite emulator, e.g. http://127.0.0.1:10000/devstoreaccount1.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://<account>.blob.core.windows.net")
					.setValue(settings.serviceUrl)
					.onChange(async (v) => {
						settings.serviceUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		const testSetting = new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Checks that the container can be listed, written, read and deleted with this SAS token.");
		const resultEl = containerEl.createDiv({ cls: "azure-blob-sync-test-result" });
		testSetting.addButton((b) =>
			b
				.setButtonText("Test connection")
				.setCta()
				.onClick(async () => {
					b.setDisabled(true);
					resultEl.empty();
					resultEl.setText("Testing…");
					try {
						const lines = await this.plugin.testConnection();
						resultEl.empty();
						for (const line of lines) resultEl.createDiv({ text: line });
					} catch (e) {
						resultEl.empty();
						resultEl.createDiv({
							text: `✗ ${e instanceof Error ? e.message : String(e)}`,
							cls: "azure-blob-sync-error",
						});
					} finally {
						b.setDisabled(false);
					}
				}),
		);

		// ---------------------------------------------------------------- Sync
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Live sync")
			.setDesc(
				"Upload changes a few seconds after you edit, check Azure for changes from other devices regularly, and sync on startup. Test the connection first.",
			)
			.addToggle((t) =>
				t.setValue(settings.liveSync).onChange(async (v) => {
					settings.liveSync = v;
					await this.plugin.saveSettings();
					if (v) void this.plugin.syncNow("manual");
				}),
			);

		new Setting(containerEl)
			.setName("Sync direction")
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(DIRECTION_LABELS)) d.addOption(value, label);
				d.setValue(settings.direction).onChange(async (v) => {
					settings.direction = v as SyncDirection;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("When a file changed on both sides")
			.setDesc("Applies when the same file was edited here and on another device since the last sync.")
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(CONFLICT_LABELS)) d.addOption(value, label);
				d.setValue(settings.conflictStrategy).onChange(async (v) => {
					settings.conflictStrategy = v as ConflictStrategy;
					await this.plugin.saveSettings();
				});
			});

		this.numberSetting(
			"Upload delay (seconds)",
			"How long to wait after the last edit before uploading.",
			"pushDelaySeconds",
			1,
			600,
		);
		this.numberSetting(
			"Check for remote changes every (seconds)",
			"How often to look for changes made on other devices. 0 turns polling off (sync then runs on startup, when Obsidian regains focus, and manually). Each check is one cheap list request.",
			"pollIntervalSeconds",
			0,
			86400,
		);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a full sync when Obsidian starts (only with live sync enabled).")
			.addToggle((t) =>
				t.setValue(settings.syncOnStartup).onChange(async (v) => {
					settings.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Sync settings folder")
			.setDesc(
				`Also sync the "${this.app.vault.configDir}" folder (settings, themes, snippets, plugins). Workspace layout files and this plugin's own settings are never synced. Changes there are picked up by the periodic check.`,
			)
			.addToggle((t) =>
				t.setValue(settings.syncConfigDir).onChange(async (v) => {
					settings.syncConfigDir = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc(
				"One pattern per line. \"*.tmp\" or \"drafts\" match a name in any folder, \"Private/\" a folder, \"/Archive\" is anchored at the vault root, \"**\" matches across folders. Hidden files and folders are always ignored.",
			)
			.addTextArea((ta) => {
				ta.setPlaceholder("Private/\n*.tmp\n/Archive/2019")
					.setValue(settings.ignorePatterns)
					.onChange(async (v) => {
						settings.ignorePatterns = v;
						await this.plugin.saveSettings();
					});
				ta.inputEl.rows = 5;
				ta.inputEl.addClass("azure-blob-sync-wide");
			});

		this.numberSetting(
			"Maximum file size (MB)",
			"Larger files are skipped. 0 means no limit.",
			"maxFileSizeMB",
			0,
			5000,
		);

		new Setting(containerEl)
			.setName("Notify on every change")
			.setDesc("Show a notice whenever a sync uploads or downloads files. Errors and conflicts are always shown.")
			.addToggle((t) =>
				t.setValue(settings.notifyOnChanges).onChange(async (v) => {
					settings.notifyOnChanges = v;
					await this.plugin.saveSettings();
				}),
			);

		// ---------------------------------------------------------------- Maintenance
		new Setting(containerEl).setName("Maintenance").setHeading();

		const syncNowSetting = new Setting(containerEl)
			.setName("Sync now")
			.addButton((b) =>
				b.setButtonText("Sync now").onClick(async () => {
					await this.plugin.syncNow("manual");
				}),
			)
			.addButton((b) =>
				b.setButtonText("Show log").onClick(() => {
					this.plugin.showLog();
				}),
			);
		this.statusEl = syncNowSetting.descEl;
		this.updateStatus();

		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc(
				"Forget what was synced before. The next sync compares every file by content: identical files are kept, files that differ are handled as conflicts, nothing is deleted.",
			)
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetSyncState();
						new Notice("Sync state reset.");
					}),
			);
	}

	private numberSetting(
		name: string,
		desc: string,
		key: "pushDelaySeconds" | "pollIntervalSeconds" | "maxFileSizeMB",
		min: number,
		max: number,
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(min);
				text.inputEl.max = String(max);
				text.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n)) return;
					this.plugin.settings[key] = Math.min(max, Math.max(min, Math.round(n)));
					await this.plugin.saveSettings();
				});
			});
	}

	private renderSasInfo(): void {
		const el = this.sasInfoEl;
		if (!el) return;
		el.empty();
		const token = this.plugin.settings.sasToken;
		if (!token) return;
		const info = parseSasToken(token);
		const bits: string[] = [];
		if (info.permissions) bits.push(`Permissions: ${info.permissions}`);
		if (info.expiry) {
			const left = describeTimeLeft(info.expiry.getTime() - Date.now());
			bits.push(`Expires: ${info.expiry.toLocaleString()}${left ? ` (in ${left})` : ""}`);
		}
		if (bits.length) el.createDiv({ text: bits.join(" · ") });
		for (const problem of validateSasToken(token)) {
			el.createDiv({ text: `⚠ ${problem}`, cls: "azure-blob-sync-error" });
		}
	}

	/** Called by the plugin whenever the sync status changes. */
	updateStatus(): void {
		this.statusEl?.setText(this.plugin.statusText());
	}

	hide(): void {
		this.sasInfoEl = null;
		this.statusEl = null;
		super.hide();
	}
}
