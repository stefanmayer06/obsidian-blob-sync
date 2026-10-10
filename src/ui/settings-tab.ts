import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	requireApiVersion,
	type SettingDefinitionItem,
} from "obsidian";
import { parseSasToken, parseSasUrl, validateSasToken } from "../azure/sas";
import type AzureBlobSyncPlugin from "../main";
import { makeDestructive } from "./buttons";
import { CONFLICT_LABELS, DIRECTION_LABELS } from "../settings";
import type { ConflictStrategy, SyncDirection } from "../sync/types";

export function describeTimeLeft(ms: number): string {
	if (ms <= 0) return "";
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 1) return "less than an hour";
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.floor(hours / 24)} days`;
}

/** One settings row: name and description for display and search, plus the controls. */
interface Row {
	name: string;
	desc?: string;
	aliases?: string[];
	render: (setting: Setting) => void;
}

interface Section {
	heading: string;
	rows: Row[];
}

type NumberKey = "pushDelaySeconds" | "pollIntervalSeconds" | "maxFileSizeMB";

/**
 * Settings tab. The rows are defined once and rendered either through
 * Obsidian's declarative settings (1.13+, which makes them searchable) or
 * imperatively by display() on older versions.
 */
export class AzureSyncSettingTab extends PluginSettingTab {
	private sasInfoEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: AzureBlobSyncPlugin,
	) {
		super(app, plugin);
	}

	/** Obsidian 1.13+: declarative rows, included in the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((section) => ({
			type: "group" as const,
			heading: section.heading,
			items: section.rows.map((row) => ({
				name: row.name,
				desc: row.desc,
				aliases: row.aliases,
				render: (setting: Setting) => row.render(setting),
			})),
		}));
	}

	/** Obsidian before 1.13: render the same rows imperatively. */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const section of this.sections()) {
			new Setting(containerEl).setName(section.heading).setHeading();
			for (const row of section.rows) {
				const setting = new Setting(containerEl).setName(row.name);
				if (row.desc) setting.setDesc(row.desc);
				row.render(setting);
			}
		}
	}

	private refresh(): void {
		if (requireApiVersion("1.13.0")) this.update();
		else this.renderLegacy();
	}

	private sections(): Section[] {
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		const textRow = (
			name: string,
			desc: string,
			key: "accountName" | "containerName" | "remotePrefix" | "serviceUrl",
			placeholder = "",
		): Row => ({
			name,
			desc,
			render: (setting) => {
				setting.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(settings[key])
						.onChange(async (v) => {
							settings[key] = v.trim();
							await save();
						}),
				);
			},
		});

		const numberRow = (name: string, desc: string, key: NumberKey, min: number, max: number): Row => ({
			name,
			desc,
			render: (setting) => {
				setting.addText((text) => {
					text.inputEl.type = "number";
					text.inputEl.min = String(min);
					text.inputEl.max = String(max);
					text.setValue(String(settings[key])).onChange(async (v) => {
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						settings[key] = Math.min(max, Math.max(min, Math.round(n)));
						await save();
					});
				});
			},
		});

		const toggleRow = (
			name: string,
			desc: string,
			key: "liveSync" | "syncOnStartup" | "syncConfigDir" | "notifyOnChanges",
			after?: (value: boolean) => void,
		): Row => ({
			name,
			desc,
			render: (setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(settings[key]).onChange(async (v) => {
						settings[key] = v;
						await save();
						after?.(v);
					}),
				);
			},
		});

		const connection: Row[] = [
			{
				name: "Quick setup: paste a blob SAS URL",
				desc:
					"In the Azure portal, open your storage account → Containers → your container → Shared access " +
					"tokens. Tick Read, Add, Create, Write, Delete and List, pick an expiry date, click \"Generate SAS " +
					"token and URL\" and paste the \"Blob SAS URL\" here to fill in the fields below.",
				aliases: ["SAS URL", "connect", "Azure portal"],
				render: (setting) => {
					let input = "";
					setting
						.addText((text) => {
							text.setPlaceholder("Paste the URL").onChange((v) => {
								input = v;
							});
							text.inputEl.addClass("azure-blob-sync-wide");
						})
						.addButton((b) =>
							b.setButtonText("Fill in").onClick(async () => {
								try {
									const parsed = parseSasUrl(input);
									if (!parsed.sasToken) {
										throw new Error("The URL has no SAS token (the part after \"?\").");
									}
									settings.sasToken = parsed.sasToken;
									settings.accountName = parsed.accountName ?? settings.accountName;
									settings.containerName = parsed.containerName ?? settings.containerName;
									settings.serviceUrl = parsed.serviceUrl ?? "";
									settings.remotePrefix = parsed.remotePrefix ?? "";
									await save();
									new Notice(
										parsed.containerName
											? "Connection details filled in."
											: "Connection details filled in. Enter the container name.",
									);
									this.refresh();
								} catch (e) {
									new Notice(e instanceof Error ? e.message : String(e));
								}
							}),
						);
				},
			},
			textRow(
				"Storage account name",
				"The name of your storage account, e.g. \"mystorageaccount\".",
				"accountName",
			),
			textRow(
				"Container name",
				"The blob container that stores the vault, e.g. \"obsidian\". It must already exist.",
				"containerName",
			),
			{
				name: "SAS token",
				desc: this.plugin.usesSecretStorage
					? "The SAS token (sv=…&sig=…). Stored in Obsidian's secret storage on this device, not in the plugin's data file."
					: "The SAS token (sv=…&sig=…). Stored in this plugin's data file inside the vault's config folder.",
				aliases: ["shared access signature", "token", "password"],
				render: (setting) => {
					setting.addText((text) => {
						text.inputEl.type = "password";
						text.inputEl.addClass("azure-blob-sync-wide");
						text.setPlaceholder("Paste the token")
							.setValue(settings.sasToken)
							.onChange(async (v) => {
								settings.sasToken = v.trim().replace(/^\?/, "");
								await save();
								this.renderSasInfo();
							});
					});
					this.sasInfoEl = setting.descEl.createDiv({ cls: "azure-blob-sync-sas-info" });
					this.renderSasInfo();
				},
			},
			textRow(
				"Remote folder",
				"Optional folder inside the container for this vault, e.g. \"vaults/personal\". Leave empty to use the container root. Lets several vaults share one container.",
				"remotePrefix",
				"Container root",
			),
			textRow(
				"Blob service URL (advanced)",
				"Leave empty for normal Azure accounts. Set it for sovereign clouds, custom domains, private endpoints or the Azurite emulator, e.g. http://127.0.0.1:10000/devstoreaccount1.",
				"serviceUrl",
			),
			{
				name: "Test connection",
				desc: "Checks that the container can be listed, written, read and deleted with this SAS token.",
				render: (setting) => {
					const resultEl = setting.descEl.createDiv({ cls: "azure-blob-sync-test-result" });
					setting.addButton((b) =>
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
				},
			},
		];

		const sync: Row[] = [
			toggleRow(
				"Live sync",
				"Upload changes a few seconds after you edit, check Azure for changes from other devices regularly, and sync on startup. Test the connection first.",
				"liveSync",
				(on) => {
					if (on) void this.plugin.syncNow("manual");
				},
			),
			{
				name: "Sync direction",
				render: (setting) => {
					setting.addDropdown((d) => {
						for (const [value, label] of Object.entries(DIRECTION_LABELS)) d.addOption(value, label);
						d.setValue(settings.direction).onChange(async (v) => {
							settings.direction = v as SyncDirection;
							await save();
						});
					});
				},
			},
			{
				name: "When a file changed on both sides",
				desc: "Applies when the same file was edited here and on another device since the last sync.",
				aliases: ["conflict"],
				render: (setting) => {
					setting.addDropdown((d) => {
						for (const [value, label] of Object.entries(CONFLICT_LABELS)) d.addOption(value, label);
						d.setValue(settings.conflictStrategy).onChange(async (v) => {
							settings.conflictStrategy = v as ConflictStrategy;
							await save();
						});
					});
				},
			},
			numberRow(
				"Upload delay (seconds)",
				"How long to wait after the last edit before uploading.",
				"pushDelaySeconds",
				1,
				600,
			),
			numberRow(
				"Check for remote changes every (seconds)",
				"How often to look for changes made on other devices. 0 turns polling off (sync then runs on startup, when Obsidian regains focus, and manually). Each check is one cheap list request.",
				"pollIntervalSeconds",
				0,
				86400,
			),
			toggleRow(
				"Sync on startup",
				"Run a full sync when Obsidian starts (only with live sync enabled).",
				"syncOnStartup",
			),
			toggleRow(
				"Sync settings folder",
				`Also sync the "${this.app.vault.configDir}" folder (settings, themes, snippets, plugins). Workspace layout files and this plugin's own settings are never synced. Changes there are picked up by the periodic check.`,
				"syncConfigDir",
			),
			{
				name: "Ignore patterns",
				desc: "One pattern per line. \"*.tmp\" or \"drafts\" match a name in any folder, \"Private/\" a folder, \"/Archive\" is anchored at the vault root, \"**\" matches across folders. Hidden files and folders are always ignored.",
				aliases: ["exclude"],
				render: (setting) => {
					setting.addTextArea((ta) => {
						ta.setPlaceholder("Private/\n*.tmp\n/Archive/2019")
							.setValue(settings.ignorePatterns)
							.onChange(async (v) => {
								settings.ignorePatterns = v;
								await save();
							});
						ta.inputEl.rows = 5;
						ta.inputEl.addClass("azure-blob-sync-wide");
					});
				},
			},
			numberRow(
				"Maximum file size (MB)",
				"Larger files are skipped. 0 means no limit.",
				"maxFileSizeMB",
				0,
				5000,
			),
			toggleRow(
				"Notify on every change",
				"Show a notice whenever a sync uploads or downloads files. Errors and conflicts are always shown.",
				"notifyOnChanges",
			),
		];

		const maintenance: Row[] = [
			{
				name: "Sync now",
				desc: "Run a full sync right away.",
				render: (setting) => {
					setting
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
					this.statusEl = setting.descEl.createDiv({ cls: "azure-blob-sync-status" });
					this.updateStatus();
				},
			},
			{
				name: "Reset sync state",
				desc: "Forget what was synced before. The next sync compares every file by content: identical files are kept, files that differ are handled as conflicts, nothing is deleted.",
				render: (setting) => {
					setting.addButton((b) =>
						makeDestructive(b.setButtonText("Reset")).onClick(async () => {
							await this.plugin.resetSyncState();
							new Notice("Sync state reset.");
						}),
					);
				},
			},
		];

		return [
			{ heading: "Connection", rows: connection },
			{ heading: "Sync", rows: sync },
			{ heading: "Maintenance", rows: maintenance },
		];
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
