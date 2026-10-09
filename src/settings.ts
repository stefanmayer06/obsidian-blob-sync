import type { ConnectionSettings } from "./azure/sas";
import type { ConflictStrategy, SyncDirection } from "./sync/types";

export interface AzureSyncSettings extends ConnectionSettings {
	/** Automatic sync: upload on change, poll for remote changes, sync on startup/focus. */
	liveSync: boolean;
	syncOnStartup: boolean;
	/** Wait this long after the last edit before uploading. */
	pushDelaySeconds: number;
	/** How often to check the container for changes from other devices. 0 = never. */
	pollIntervalSeconds: number;
	direction: SyncDirection;
	conflictStrategy: ConflictStrategy;
	syncConfigDir: boolean;
	/** Newline separated ignore patterns. */
	ignorePatterns: string;
	/** Skip files larger than this. 0 = no limit. */
	maxFileSizeMB: number;
	/** Show a notice for every sync that changed something. */
	notifyOnChanges: boolean;
	/** True when the SAS token lives in Obsidian's secret storage instead of data.json. */
	sasInSecretStorage: boolean;
}

export const DEFAULT_SETTINGS: AzureSyncSettings = {
	accountName: "",
	containerName: "",
	sasToken: "",
	serviceUrl: "",
	remotePrefix: "",
	liveSync: false,
	syncOnStartup: true,
	pushDelaySeconds: 3,
	pollIntervalSeconds: 30,
	direction: "bidirectional",
	conflictStrategy: "keep-both",
	syncConfigDir: false,
	ignorePatterns: "",
	maxFileSizeMB: 200,
	notifyOnChanges: false,
	sasInSecretStorage: false,
};

export const DIRECTION_LABELS: Record<SyncDirection, string> = {
	bidirectional: "Two-way (sync changes in both directions)",
	"upload-only": "Upload only (back up this vault, never change local files)",
	"download-only": "Download only (mirror the container, never change the container)",
};

export const CONFLICT_LABELS: Record<ConflictStrategy, string> = {
	"keep-both": "Keep both (save the other version as a conflict copy)",
	"newest-wins": "Newest modification wins",
	"local-wins": "This device wins",
	"remote-wins": "Azure (other device) wins",
};

/** Keys that define which container/folder we sync with. */
export const CONNECTION_KEYS: (keyof ConnectionSettings)[] = [
	"accountName",
	"containerName",
	"sasToken",
	"serviceUrl",
	"remotePrefix",
];
