import {
	RemoteConflictError,
	emptyResult,
	type ConflictStrategy,
	type FileState,
	type LocalFileInfo,
	type LocalFileSystem,
	type RemoteFileInfo,
	type RemoteStore,
	type SyncDirection,
	type SyncResult,
	type SyncState,
} from "./types";
import { Mutex, conflictCopyPath, runWithConcurrency, sha256Hex } from "./util";

export interface SyncEngineOptions {
	direction: SyncDirection;
	conflictStrategy: ConflictStrategy;
	/** Strategy override per path (e.g. config files never get conflict copies). */
	conflictStrategyFor?: (path: string) => ConflictStrategy | undefined;
	/** Ignore rules: only paths returning true are synced. */
	isSyncable: (path: string) => boolean;
	/** Files larger than this (bytes) are skipped. 0 = no limit. */
	maxFileSize: number;
	/** Parallel transfers. */
	concurrency: number;
	/** Deletions are held back when more than this many... */
	massDeleteMinCount: number;
	/** ...and more than this fraction of all tracked files would be deleted. */
	massDeleteRatio: number;
	now?: () => Date;
	log?: (message: string) => void;
}

export const DEFAULT_ENGINE_OPTIONS: Omit<SyncEngineOptions, "isSyncable"> = {
	direction: "bidirectional",
	conflictStrategy: "keep-both",
	maxFileSize: 0,
	concurrency: 4,
	massDeleteMinCount: 10,
	massDeleteRatio: 0.5,
};

type Action =
	| { kind: "upload"; path: string; local: LocalFileInfo; ifMatch?: string; ifNoneMatchAny?: boolean }
	| { kind: "download"; path: string; local: LocalFileInfo | null; remote: RemoteFileInfo }
	| { kind: "deleteLocal"; path: string; local: LocalFileInfo }
	| { kind: "deleteRemote"; path: string; ifMatch?: string }
	| { kind: "conflict"; path: string; local: LocalFileInfo; remote: RemoteFileInfo }
	| { kind: "record"; path: string; state: FileState }
	| { kind: "forget"; path: string }
	| { kind: "skip"; path: string; reason: string };

interface HashCacheEntry {
	mtime: number;
	size: number;
	sha256: string;
}

/**
 * Three-way sync between the vault and a blob container.
 *
 * For every path the engine compares the local file, the remote blob and the
 * state recorded after the last successful sync of that path. This tells
 * which side changed, so edits are propagated in the right direction,
 * deletions are mirrored, and true conflicts (both sides changed) are
 * detected instead of silently overwritten. Writes to the container use ETag
 * preconditions, so a change made by another device between listing and
 * uploading is never clobbered.
 */
export class SyncEngine {
	private hashCache = new Map<string, HashCacheEntry>();
	private dirty = false;

	constructor(
		private readonly local: LocalFileSystem,
		private readonly remote: RemoteStore,
		private state: SyncState,
		private options: SyncEngineOptions,
		private readonly saveState: (state: SyncState) => Promise<void>,
		/** Share one mutex between engine instances that operate on the same vault. */
		private readonly mutex: Mutex = new Mutex(),
	) {}

	get isBusy(): boolean {
		return this.mutex.isLocked;
	}

	getState(): SyncState {
		return this.state;
	}

	updateOptions(options: Partial<SyncEngineOptions>): void {
		this.options = { ...this.options, ...options };
	}

	/** Full reconciliation of local and remote. */
	fullSync(opts: { allowMassDelete?: boolean } = {}): Promise<SyncResult> {
		return this.mutex.run(() => this.doFullSync(opts.allowMassDelete ?? false));
	}

	/**
	 * Pushes local changes for specific paths (from vault events) without
	 * listing the whole container. Lost races set `needsResync`.
	 */
	pushPaths(paths: string[], opts: { allowMassDelete?: boolean } = {}): Promise<SyncResult> {
		return this.mutex.run(() => this.doPushPaths(paths, opts.allowMassDelete ?? false));
	}

	/**
	 * Drops the sync record of these paths, so the next sync treats them as
	 * new and restores them on whichever side they are missing. Used when the
	 * user declines deletions held back by the safety check.
	 */
	forgetPaths(paths: string[]): Promise<void> {
		return this.mutex.run(async () => {
			for (const path of paths) {
				if (path in this.state.files) this.forget(path);
			}
			await this.persist();
		});
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private async doFullSync(allowMassDelete: boolean): Promise<SyncResult> {
		this.hashCache = new Map();
		const result = emptyResult();
		const { isSyncable } = this.options;

		const remoteFiles = new Map<string, RemoteFileInfo>();
		for (const r of await this.remote.list()) {
			if (isSyncable(r.path)) remoteFiles.set(r.path, r);
		}
		const localFiles = new Map<string, LocalFileInfo>();
		for (const l of await this.local.listFiles()) {
			if (isSyncable(l.path)) localFiles.set(l.path, l);
		}

		const paths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys()]);
		for (const path of Object.keys(this.state.files)) {
			if (isSyncable(path)) paths.add(path);
			else {
				// Newly ignored: forget it, never delete anything because of an ignore rule.
				delete this.state.files[path];
				this.dirty = true;
			}
		}

		const actions: Action[] = [];
		for (const path of [...paths].sort()) {
			try {
				const action = await this.decide(
					path,
					localFiles.get(path) ?? null,
					remoteFiles.get(path) ?? null,
					this.state.files[path],
				);
				if (action) actions.push(action);
			} catch (e) {
				result.errors.push({ path, message: errorMessage(e) });
			}
		}

		await this.execute(actions, result, allowMassDelete);
		this.log(summarize("Full sync", result));
		return result;
	}

	private async doPushPaths(paths: string[], allowMassDelete: boolean): Promise<SyncResult> {
		const result = emptyResult();
		if (this.options.direction === "download-only") return result;
		const actions: Action[] = [];
		for (const path of [...new Set(paths)].sort()) {
			if (!this.options.isSyncable(path)) continue;
			try {
				const local = await this.local.stat(path);
				const known = this.state.files[path];
				const unconditional = this.options.direction === "upload-only";
				if (local) {
					if (known && !(await this.localChanged(local, known))) {
						if (known.mtime !== local.mtime || known.size !== local.size) {
							actions.push({
								kind: "record",
								path,
								state: { ...known, mtime: local.mtime, size: local.size },
							});
						}
						continue;
					}
					if (this.tooLarge(local.size)) {
						actions.push({ kind: "skip", path, reason: "file is larger than the size limit" });
						continue;
					}
					actions.push({
						kind: "upload",
						path,
						local,
						ifMatch: unconditional ? undefined : known?.etag,
						ifNoneMatchAny: unconditional ? undefined : !known,
					});
				} else if (known) {
					actions.push({ kind: "deleteRemote", path, ifMatch: unconditional ? undefined : known.etag });
				}
			} catch (e) {
				result.errors.push({ path, message: errorMessage(e) });
			}
		}
		await this.execute(actions, result, allowMassDelete);
		return result;
	}

	private tooLarge(size: number): boolean {
		return this.options.maxFileSize > 0 && size > this.options.maxFileSize;
	}

	private async hashLocal(file: LocalFileInfo): Promise<string> {
		const cached = this.hashCache.get(file.path);
		if (cached && cached.mtime === file.mtime && cached.size === file.size) return cached.sha256;
		const sha256 = await sha256Hex(await this.local.read(file.path));
		this.hashCache.set(file.path, { mtime: file.mtime, size: file.size, sha256 });
		return sha256;
	}

	private async localChanged(local: LocalFileInfo, known: FileState): Promise<boolean> {
		if (local.mtime === known.mtime && local.size === known.size) return false;
		if (local.size !== known.size) return true;
		return (await this.hashLocal(local)) !== known.sha256;
	}

	private remoteChanged(remote: RemoteFileInfo, known: FileState): boolean {
		if (remote.etag === known.etag) return false;
		return !(remote.sha256 && remote.sha256 === known.sha256);
	}

	/** State describing an in-sync pair, or null if the stored state is already accurate. */
	private refreshedState(
		local: LocalFileInfo,
		remote: RemoteFileInfo,
		sha256: string,
		known?: FileState,
	): FileState | null {
		const next: FileState = { mtime: local.mtime, size: local.size, etag: remote.etag, sha256 };
		if (
			known &&
			known.mtime === next.mtime &&
			known.size === next.size &&
			known.etag === next.etag &&
			known.sha256 === next.sha256
		) {
			return null;
		}
		return next;
	}

	private async decide(
		path: string,
		local: LocalFileInfo | null,
		remote: RemoteFileInfo | null,
		known: FileState | undefined,
	): Promise<Action | null> {
		const { direction } = this.options;

		if (!local && !remote) {
			return known ? { kind: "forget", path } : null;
		}
		if ((local && this.tooLarge(local.size)) || (remote && this.tooLarge(remote.size))) {
			return { kind: "skip", path, reason: "file is larger than the size limit" };
		}

		if (direction === "upload-only") {
			if (local) {
				if (remote) {
					if (known && remote.etag === known.etag && !(await this.localChanged(local, known))) {
						const st = this.refreshedState(local, remote, known.sha256, known);
						return st ? { kind: "record", path, state: st } : null;
					}
					const sha = await this.hashLocal(local);
					if (remote.sha256 === sha) {
						const st = this.refreshedState(local, remote, sha, known);
						return st ? { kind: "record", path, state: st } : null;
					}
				}
				return { kind: "upload", path, local };
			}
			// Only remove blobs this device put there (or synced before).
			if (remote && known) return { kind: "deleteRemote", path };
			return known ? { kind: "forget", path } : null;
		}

		if (direction === "download-only") {
			if (remote) {
				if (local) {
					if (known && remote.etag === known.etag && !(await this.localChanged(local, known))) {
						const st = this.refreshedState(local, remote, known.sha256, known);
						return st ? { kind: "record", path, state: st } : null;
					}
					if (remote.sha256 && remote.sha256 === (await this.hashLocal(local))) {
						const st = this.refreshedState(local, remote, remote.sha256, known);
						return st ? { kind: "record", path, state: st } : null;
					}
				}
				return { kind: "download", path, local, remote };
			}
			if (local && known) return { kind: "deleteLocal", path, local };
			return known ? { kind: "forget", path } : null;
		}

		// Bidirectional
		if (local && remote) {
			if (known) {
				const lc = await this.localChanged(local, known);
				const rc = this.remoteChanged(remote, known);
				if (!lc && !rc) {
					const st = this.refreshedState(local, remote, known.sha256, known);
					return st ? { kind: "record", path, state: st } : null;
				}
				if (lc && !rc) return { kind: "upload", path, local, ifMatch: remote.etag };
				if (!lc && rc) return { kind: "download", path, local, remote };
			}
			// Both changed, or first time we see this pair.
			if (remote.sha256 && local.size === remote.size) {
				const sha = await this.hashLocal(local);
				if (sha === remote.sha256) {
					const st = this.refreshedState(local, remote, sha, known);
					return st ? { kind: "record", path, state: st } : null;
				}
			}
			return { kind: "conflict", path, local, remote };
		}

		if (local) {
			if (!known) return { kind: "upload", path, local, ifNoneMatchAny: true };
			// Deleted remotely. Local edits since the last sync win over the deletion.
			if (await this.localChanged(local, known)) {
				return { kind: "upload", path, local, ifNoneMatchAny: true };
			}
			return { kind: "deleteLocal", path, local };
		}

		// Only remote
		if (!known) return { kind: "download", path, local: null, remote: remote! };
		// Deleted locally. Remote edits since the last sync win over the deletion.
		if (this.remoteChanged(remote!, known)) return { kind: "download", path, local: null, remote: remote! };
		return { kind: "deleteRemote", path, ifMatch: remote!.etag };
	}

	private async execute(actions: Action[], result: SyncResult, allowMassDelete: boolean): Promise<void> {
		// Mass-deletion safety check.
		const tracked = Math.max(1, Object.keys(this.state.files).length);
		const { massDeleteMinCount, massDeleteRatio } = this.options;
		const blocked = (count: number) =>
			!allowMassDelete && count > massDeleteMinCount && count > tracked * massDeleteRatio;
		const localDeletes = actions.filter((a) => a.kind === "deleteLocal");
		const remoteDeletes = actions.filter((a) => a.kind === "deleteRemote");
		let runnable = actions;
		if (blocked(localDeletes.length)) {
			result.blockedDeletions.local = localDeletes.map((a) => a.path);
			runnable = runnable.filter((a) => a.kind !== "deleteLocal");
			this.log(`Held back ${localDeletes.length} local deletions (safety check).`);
		}
		if (blocked(remoteDeletes.length)) {
			result.blockedDeletions.remote = remoteDeletes.map((a) => a.path);
			runnable = runnable.filter((a) => a.kind !== "deleteRemote");
			this.log(`Held back ${remoteDeletes.length} remote deletions (safety check).`);
		}

		// Cheap bookkeeping first, then transfers in parallel.
		const transfers: Action[] = [];
		for (const action of runnable) {
			if (action.kind === "record") {
				this.state.files[action.path] = action.state;
				this.dirty = true;
			} else if (action.kind === "forget") {
				delete this.state.files[action.path];
				this.dirty = true;
			} else if (action.kind === "skip") {
				result.skipped.push({ path: action.path, reason: action.reason });
			} else {
				transfers.push(action);
			}
		}

		let sinceSave = 0;
		await runWithConcurrency(transfers, this.options.concurrency, async (action) => {
			try {
				await this.run(action, result);
			} catch (e) {
				if (e instanceof RemoteConflictError || e instanceof LocalChangedError) {
					result.needsResync = true;
					this.log(`${action.path}: changed during sync, will retry (${e.message})`);
				} else {
					result.errors.push({ path: action.path, message: errorMessage(e) });
					this.log(`${action.path}: ${errorMessage(e)}`);
				}
			}
			if (++sinceSave >= 25) {
				sinceSave = 0;
				await this.persist();
			}
		});
		await this.persist();
	}

	private async persist(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		await this.saveState(this.state);
	}

	private setState(path: string, state: FileState): void {
		this.state.files[path] = state;
		this.dirty = true;
	}

	private forget(path: string): void {
		delete this.state.files[path];
		this.dirty = true;
	}

	/** Throws LocalChangedError if the local file differs from the snapshot the decision used. */
	private async assertLocalUnchanged(path: string, snapshot: LocalFileInfo | null): Promise<LocalFileInfo | null> {
		const current = await this.local.stat(path);
		if (!snapshot && !current) return null;
		if (!snapshot || !current || snapshot.mtime !== current.mtime || snapshot.size !== current.size) {
			throw new LocalChangedError(`local file changed`);
		}
		return current;
	}

	private async run(action: Action, result: SyncResult): Promise<void> {
		switch (action.kind) {
			case "upload": {
				const uploaded = await this.uploadFile(action.path, {
					ifMatch: action.ifMatch,
					ifNoneMatchAny: action.ifNoneMatchAny,
				});
				if (uploaded) result.uploaded.push(action.path);
				return;
			}
			case "download": {
				await this.assertLocalUnchanged(action.path, action.local);
				const { data, info } = await this.remote.download(action.path);
				await this.writeLocal(action.path, data, info);
				result.downloaded.push(action.path);
				return;
			}
			case "deleteLocal": {
				await this.assertLocalUnchanged(action.path, action.local);
				await this.local.delete(action.path);
				this.forget(action.path);
				result.deletedLocal.push(action.path);
				return;
			}
			case "deleteRemote": {
				await this.remote.delete(action.path, { ifMatch: action.ifMatch });
				this.forget(action.path);
				result.deletedRemote.push(action.path);
				return;
			}
			case "conflict":
				await this.resolveConflict(action.path, action.local, action.remote, result);
				return;
			default:
				return;
		}
	}

	private async uploadFile(
		path: string,
		conditions: { ifMatch?: string; ifNoneMatchAny?: boolean },
	): Promise<boolean> {
		const stat = await this.local.stat(path);
		if (!stat) return false; // deleted meanwhile; the next sync handles it
		const data = await this.local.read(path);
		const sha256 = await sha256Hex(data);
		const info = await this.remote.upload(path, data, { mtime: stat.mtime, sha256, ...conditions });
		this.setState(path, { mtime: stat.mtime, size: stat.size, etag: info.etag, sha256 });
		return true;
	}

	private async writeLocal(path: string, data: ArrayBuffer, info: RemoteFileInfo): Promise<string> {
		const sha256 = await sha256Hex(data);
		await this.local.write(path, data, info.mtime ?? info.lastModified);
		const st = await this.local.stat(path);
		this.setState(path, {
			// If the size doesn't match, something else wrote the file: force a hash check next time.
			mtime: st && st.size === data.byteLength ? st.mtime : -1,
			size: st ? st.size : data.byteLength,
			etag: info.etag,
			sha256,
		});
		return sha256;
	}

	private async resolveConflict(
		path: string,
		local: LocalFileInfo,
		remote: RemoteFileInfo,
		result: SyncResult,
	): Promise<void> {
		await this.assertLocalUnchanged(path, local);
		const { data: remoteData, info } = await this.remote.download(path);
		const remoteSha = await sha256Hex(remoteData);
		const localSha = await this.hashLocal(local);
		if (remoteSha === localSha) {
			this.setState(path, { mtime: local.mtime, size: local.size, etag: info.etag, sha256: localSha });
			result.conflicts.push({ path, resolution: "identical" });
			return;
		}

		let strategy = this.options.conflictStrategyFor?.(path) ?? this.options.conflictStrategy;
		if (strategy === "newest-wins") {
			const remoteTime = info.mtime ?? remote.mtime ?? info.lastModified;
			strategy = local.mtime >= remoteTime ? "local-wins" : "remote-wins";
		}

		switch (strategy) {
			case "remote-wins":
				await this.assertLocalUnchanged(path, local);
				await this.writeLocal(path, remoteData, info);
				result.conflicts.push({ path, resolution: "remote" });
				result.downloaded.push(path);
				return;
			case "local-wins":
				await this.uploadFile(path, { ifMatch: info.etag });
				result.conflicts.push({ path, resolution: "local" });
				result.uploaded.push(path);
				return;
			case "keep-both": {
				const now = this.options.now?.() ?? new Date();
				const taken = new Set<string>();
				let copyPath: string;
				for (;;) {
					copyPath = conflictCopyPath(path, now, (p) => p in this.state.files || taken.has(p));
					if (!(await this.local.stat(copyPath))) break;
					taken.add(copyPath);
				}
				// Save the remote version next to the local one, on both sides.
				await this.writeLocal(copyPath, remoteData, info);
				await this.uploadFile(copyPath, { ifNoneMatchAny: true });
				// Then the local version becomes the current one.
				await this.uploadFile(path, { ifMatch: info.etag });
				result.conflicts.push({ path, resolution: "kept-both", conflictCopy: copyPath });
				result.uploaded.push(path);
				return;
			}
		}
	}
}

class LocalChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalChangedError";
	}
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function summarize(label: string, r: SyncResult): string {
	return (
		`${label}: ${r.uploaded.length} up, ${r.downloaded.length} down, ` +
		`${r.deletedLocal.length} deleted locally, ${r.deletedRemote.length} deleted remotely, ` +
		`${r.conflicts.length} conflicts, ${r.errors.length} errors`
	);
}
