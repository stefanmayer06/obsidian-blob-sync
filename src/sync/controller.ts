import type { SyncEngine } from "./engine";
import { emptyResult, type SyncResult } from "./types";

export type SyncStatus =
	| { kind: "idle"; lastSync?: Date }
	| { kind: "syncing" }
	| { kind: "error"; message: string }
	| { kind: "unconfigured"; message: string };

export interface SyncControllerDeps {
	/** Current engine, or a reason why syncing isn't possible. */
	getEngine(): SyncEngine | { error: string };
	/** Delay after the last local change before uploading. */
	pushDelayMs(): number;
	onStatus(status: SyncStatus): void;
	onResult(result: SyncResult, trigger: SyncTrigger): void;
	onError(error: unknown, trigger: SyncTrigger): void;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	now?: () => number;
}

export type SyncTrigger = "manual" | "startup" | "poll" | "push" | "resync" | "focus" | "folder";

const MAX_RESYNC_ROUNDS = 3;

/**
 * Turns vault events and timers into engine calls: debounces local changes
 * into batched pushes, coalesces overlapping full-sync requests, and follows
 * up with a full sync when a push lost a race against another device.
 */
export class SyncController {
	private pending = new Set<string>();
	private firstPendingAt = 0;
	private pushTimer: unknown = null;
	private fullRun: Promise<SyncResult | null> | null = null;
	private fullQueued: { trigger: SyncTrigger; allowMassDelete: boolean } | null = null;
	private disposed = false;
	private lastSync: Date | undefined;

	constructor(private readonly deps: SyncControllerDeps) {}

	private get setTimer() {
		return this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	}
	private get clearTimer() {
		return this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}
	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	get hasPendingChanges(): boolean {
		return this.pending.size > 0;
	}

	get isSyncing(): boolean {
		return this.fullRun !== null;
	}

	/** Record a local change; it is uploaded after the configured delay. */
	notifyChange(...paths: string[]): void {
		if (this.disposed) return;
		if (this.pending.size === 0) this.firstPendingAt = this.now();
		for (const p of paths) this.pending.add(p);
		this.schedulePush();
	}

	private schedulePush(): void {
		if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
		const delay = this.deps.pushDelayMs();
		// Keep uploading during long editing sessions instead of waiting for a pause.
		const maxWait = Math.max(delay * 10, 20_000);
		const waited = this.now() - this.firstPendingAt;
		const wait = Math.max(0, Math.min(delay, maxWait - waited));
		this.pushTimer = this.setTimer(() => {
			this.pushTimer = null;
			void this.flush();
		}, wait);
	}

	/** Upload pending local changes now. */
	async flush(): Promise<SyncResult | null> {
		if (this.pushTimer !== null) {
			this.clearTimer(this.pushTimer);
			this.pushTimer = null;
		}
		if (this.pending.size === 0 || this.disposed) return null;
		const engine = this.deps.getEngine();
		if ("error" in engine) {
			this.pending.clear();
			return null;
		}
		const paths = [...this.pending];
		this.pending.clear();
		try {
			const result = await engine.pushPaths(paths);
			this.deps.onResult(result, "push");
			if (result.needsResync) void this.requestFullSync("resync");
			else if (result.errors.length === 0) this.markSynced();
			return result;
		} catch (e) {
			this.deps.onError(e, "push");
			return null;
		}
	}

	private markSynced(): void {
		this.lastSync = new Date(this.now());
		if (!this.fullRun) this.deps.onStatus({ kind: "idle", lastSync: this.lastSync });
	}

	/**
	 * Run a full sync. If one is already running, another one is queued to
	 * run right after it (multiple requests collapse into one).
	 */
	requestFullSync(trigger: SyncTrigger, opts: { allowMassDelete?: boolean } = {}): Promise<SyncResult | null> {
		if (this.disposed) return Promise.resolve(null);
		const allowMassDelete = opts.allowMassDelete ?? false;
		if (this.fullRun) {
			this.fullQueued = {
				trigger,
				allowMassDelete: allowMassDelete || (this.fullQueued?.allowMassDelete ?? false),
			};
			return this.fullRun;
		}
		this.fullRun = this.runFullLoop(trigger, allowMassDelete).finally(() => {
			this.fullRun = null;
		});
		return this.fullRun;
	}

	private async runFullLoop(trigger: SyncTrigger, allowMassDelete: boolean): Promise<SyncResult | null> {
		let last: SyncResult | null = null;
		let current: { trigger: SyncTrigger; allowMassDelete: boolean } | null = { trigger, allowMassDelete };
		let resyncRounds = 0;
		while (current && !this.disposed) {
			this.fullQueued = null;
			last = await this.runFullOnce(current.trigger, current.allowMassDelete);
			current = this.fullQueued;
			if (!current && last?.needsResync && resyncRounds < MAX_RESYNC_ROUNDS) {
				resyncRounds++;
				current = { trigger: "resync", allowMassDelete: false };
			}
		}
		return last;
	}

	private async runFullOnce(trigger: SyncTrigger, allowMassDelete: boolean): Promise<SyncResult | null> {
		const engine = this.deps.getEngine();
		if ("error" in engine) {
			this.deps.onStatus({ kind: "unconfigured", message: engine.error });
			return null;
		}
		// Changes noticed so far are covered by the full sync.
		this.pending.clear();
		if (this.pushTimer !== null) {
			this.clearTimer(this.pushTimer);
			this.pushTimer = null;
		}
		this.deps.onStatus({ kind: "syncing" });
		try {
			const result = await engine.fullSync({ allowMassDelete });
			this.deps.onResult(result, trigger);
			if (result.errors.length) {
				this.deps.onStatus({
					kind: "error",
					message: `${result.errors.length} file(s) failed: ${result.errors[0].message}`,
				});
			} else {
				this.lastSync = new Date(this.now());
				this.deps.onStatus({ kind: "idle", lastSync: this.lastSync });
			}
			return result;
		} catch (e) {
			this.deps.onError(e, trigger);
			const message = e instanceof Error ? e.message : String(e);
			this.deps.onStatus({ kind: "error", message });
			const failed = emptyResult();
			failed.errors.push({ path: "", message });
			return failed;
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.pushTimer !== null) this.clearTimer(this.pushTimer);
		this.pushTimer = null;
		this.pending.clear();
	}
}
