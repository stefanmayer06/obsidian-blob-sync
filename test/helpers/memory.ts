import {
	RemoteConflictError,
	type LocalFileInfo,
	type LocalFileSystem,
	type RemoteFileInfo,
	type RemoteStore,
	type UploadOptions,
} from "../../src/sync/types";
import { sha256Hex } from "../../src/sync/util";

export const enc = (s: string): ArrayBuffer => {
	const u = new TextEncoder().encode(s);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};
export const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

/** Shared fake clock so mtimes move forward deterministically. */
export class Clock {
	constructor(public t = 1_700_000_000_000) {}
	tick(ms = 1000): number {
		this.t += ms;
		return this.t;
	}
}

interface MemFile {
	data: ArrayBuffer;
	mtime: number;
}

export class MemoryLocalFs implements LocalFileSystem {
	files = new Map<string, MemFile>();
	trash: string[] = [];
	/** Hook to simulate concurrent edits: called after listFiles(). */
	afterList?: () => void;

	constructor(private readonly clock: Clock) {}

	set(path: string, content: string | ArrayBuffer, mtime?: number): void {
		this.files.set(path, {
			data: typeof content === "string" ? enc(content) : content,
			mtime: mtime ?? this.clock.tick(),
		});
	}

	get(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? dec(f.data) : undefined;
	}

	remove(path: string): void {
		this.files.delete(path);
	}

	/** Change mtime but not content. */
	touch(path: string): void {
		const f = this.files.get(path)!;
		f.mtime = this.clock.tick();
	}

	async listFiles(): Promise<LocalFileInfo[]> {
		const out = [...this.files.entries()].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
		this.afterList?.();
		return out;
	}

	async stat(path: string): Promise<LocalFileInfo | null> {
		const f = this.files.get(path);
		return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
	}

	async read(path: string): Promise<ArrayBuffer> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data.slice(0);
	}

	async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		this.files.set(path, { data: data.slice(0), mtime: mtime > 0 ? mtime : this.clock.tick() });
	}

	async delete(path: string): Promise<void> {
		this.files.delete(path);
		this.trash.push(path);
	}
}

interface MemBlob {
	data: ArrayBuffer;
	etag: string;
	lastModified: number;
	mtime?: number;
	sha256?: string;
}

/** In-memory RemoteStore with Azure-like ETag precondition semantics. */
export class MemoryRemoteStore implements RemoteStore {
	blobs = new Map<string, MemBlob>();
	private etagCounter = 0;
	calls = { list: 0, download: 0, upload: 0, delete: 0 };

	constructor(private readonly clock: Clock) {}

	private nextEtag(): string {
		return `0x${(++this.etagCounter).toString(16).padStart(8, "0")}`;
	}

	/** Simulates another tool writing a blob (optionally without metadata). */
	async putExternal(path: string, content: string, withMetadata = true): Promise<void> {
		const data = enc(content);
		this.blobs.set(path, {
			data,
			etag: this.nextEtag(),
			lastModified: this.clock.tick(),
			mtime: withMetadata ? this.clock.t : undefined,
			sha256: withMetadata ? await sha256Hex(data) : undefined,
		});
	}

	get(path: string): string | undefined {
		const b = this.blobs.get(path);
		return b ? dec(b.data) : undefined;
	}

	private info(path: string, b: MemBlob): RemoteFileInfo {
		return {
			path,
			etag: b.etag,
			lastModified: b.lastModified,
			size: b.data.byteLength,
			mtime: b.mtime,
			sha256: b.sha256,
		};
	}

	async list(): Promise<RemoteFileInfo[]> {
		this.calls.list++;
		return [...this.blobs.entries()].map(([p, b]) => this.info(p, b));
	}

	async download(path: string): Promise<{ data: ArrayBuffer; info: RemoteFileInfo }> {
		this.calls.download++;
		const b = this.blobs.get(path);
		if (!b) throw new Error(`BlobNotFound ${path}`);
		return { data: b.data.slice(0), info: this.info(path, b) };
	}

	async upload(path: string, data: ArrayBuffer, options: UploadOptions): Promise<RemoteFileInfo> {
		this.calls.upload++;
		const existing = this.blobs.get(path);
		if (options.ifNoneMatchAny && existing) throw new RemoteConflictError(`${path} exists`);
		if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
			throw new RemoteConflictError(`${path} etag mismatch`);
		}
		const blob: MemBlob = {
			data: data.slice(0),
			etag: this.nextEtag(),
			lastModified: this.clock.tick(),
			mtime: options.mtime,
			sha256: options.sha256,
		};
		this.blobs.set(path, blob);
		return this.info(path, blob);
	}

	async delete(path: string, options: { ifMatch?: string }): Promise<void> {
		this.calls.delete++;
		const existing = this.blobs.get(path);
		if (!existing) return;
		if (options.ifMatch && existing.etag !== options.ifMatch) {
			throw new RemoteConflictError(`${path} etag mismatch`);
		}
		this.blobs.delete(path);
	}
}
