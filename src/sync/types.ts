/** A file as seen on the local device. Paths are vault relative, "/" separated. */
export interface LocalFileInfo {
	path: string;
	/** Modification time in ms since epoch. */
	mtime: number;
	size: number;
}

export interface LocalFileSystem {
	/** All files that could be synced (the engine applies the ignore rules). */
	listFiles(): Promise<LocalFileInfo[]>;
	stat(path: string): Promise<LocalFileInfo | null>;
	read(path: string): Promise<ArrayBuffer>;
	/** Creates or overwrites a file (creating parent folders as needed). */
	write(path: string, data: ArrayBuffer, mtime: number): Promise<void>;
	/** Removes a file (implementations should move it to the trash). */
	delete(path: string): Promise<void>;
}

/** A file as stored in the remote container. */
export interface RemoteFileInfo {
	path: string;
	etag: string;
	/** Server side last-modified time (ms). */
	lastModified: number;
	size: number;
	/** Original file modification time, if recorded in the blob metadata. */
	mtime?: number;
	/** SHA-256 (hex) of the content, if recorded in the blob metadata. */
	sha256?: string;
}

export interface UploadOptions {
	mtime: number;
	sha256: string;
	/** Fail with RemoteConflictError unless the remote ETag still matches. */
	ifMatch?: string;
	/** Fail with RemoteConflictError if the blob already exists. */
	ifNoneMatchAny?: boolean;
}

export interface RemoteStore {
	list(): Promise<RemoteFileInfo[]>;
	download(path: string): Promise<{ data: ArrayBuffer; info: RemoteFileInfo }>;
	upload(path: string, data: ArrayBuffer, options: UploadOptions): Promise<RemoteFileInfo>;
	/** Deletes a blob; a missing blob is not an error. */
	delete(path: string, options: { ifMatch?: string }): Promise<void>;
}

/** Thrown by a RemoteStore when a conditional request lost a race. */
export class RemoteConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteConflictError";
	}
}

/** What both sides looked like the last time a file was in sync. */
export interface FileState {
	/** Local mtime after the last sync (-1 = unknown, forces a hash check). */
	mtime: number;
	size: number;
	etag: string;
	sha256: string;
}

export interface SyncState {
	version: 1;
	/** Identifies the container/prefix this state belongs to. */
	target: string;
	files: Record<string, FileState>;
}

export function emptyState(target: string): SyncState {
	return { version: 1, target, files: {} };
}

export type SyncDirection = "bidirectional" | "upload-only" | "download-only";

export type ConflictStrategy = "keep-both" | "newest-wins" | "local-wins" | "remote-wins";

export interface ConflictRecord {
	path: string;
	resolution: "kept-both" | "local" | "remote" | "identical";
	conflictCopy?: string;
}

export interface SyncResult {
	uploaded: string[];
	downloaded: string[];
	deletedLocal: string[];
	deletedRemote: string[];
	conflicts: ConflictRecord[];
	skipped: { path: string; reason: string }[];
	errors: { path: string; message: string }[];
	/** Deletions held back by the mass-deletion safety check. */
	blockedDeletions: { local: string[]; remote: string[] };
	/** The remote changed while syncing; another full sync should run. */
	needsResync: boolean;
}

export function emptyResult(): SyncResult {
	return {
		uploaded: [],
		downloaded: [],
		deletedLocal: [],
		deletedRemote: [],
		conflicts: [],
		skipped: [],
		errors: [],
		blockedDeletions: { local: [], remote: [] },
		needsResync: false,
	};
}

export function changeCount(result: SyncResult): number {
	return (
		result.uploaded.length +
		result.downloaded.length +
		result.deletedLocal.length +
		result.deletedRemote.length +
		result.conflicts.filter((c) => c.resolution !== "identical").length
	);
}
