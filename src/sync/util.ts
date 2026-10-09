/** SHA-256 of the data as lower case hex (WebCrypto: available in Obsidian and Node 18+). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
	return hex;
}

/** Runs the tasks with at most `limit` running at the same time. */
export async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;
	const runners: Promise<void>[] = [];
	const next = async (): Promise<void> => {
		while (index < items.length) {
			const item = items[index++];
			await worker(item);
		}
	};
	for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) runners.push(next());
	await Promise.all(runners);
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * "folder/Note.md" -> "folder/Note (conflict 2026-01-31 13-45-12).md".
 * `exists` is consulted to avoid clobbering an earlier conflict copy.
 */
export function conflictCopyPath(path: string, date: Date, exists: (p: string) => boolean): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const file = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = file.lastIndexOf(".");
	const hasExt = dot > 0;
	const base = hasExt ? file.slice(0, dot) : file;
	const ext = hasExt ? file.slice(dot) : "";
	const stamp =
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
	let candidate = `${dir}${base} (conflict ${stamp})${ext}`;
	let counter = 2;
	while (exists(candidate)) {
		candidate = `${dir}${base} (conflict ${stamp} ${counter})${ext}`;
		counter++;
	}
	return candidate;
}

/** Simple async mutex that serializes callers. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();
	private held = false;

	get isLocked(): boolean {
		return this.held;
	}

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.tail.then(async () => {
			this.held = true;
			try {
				return await fn();
			} finally {
				this.held = false;
			}
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
