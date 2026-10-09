import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal Chrome DevTools Protocol client (Node 22 has a global WebSocket). */
export class Cdp {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	readonly exceptions: string[] = [];
	readonly consoleErrors: string[] = [];

	private constructor(private readonly ws: WebSocket) {
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data));
			if (msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method === "Runtime.exceptionThrown") {
				const d = msg.params.exceptionDetails;
				this.exceptions.push(`${d.text} ${d.exception?.description ?? ""}`);
			} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
				this.consoleErrors.push(
					msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "),
				);
			}
		});
	}

	static async connect(
		port: number,
		timeoutMs = 60_000,
		match: (t: { type: string; url: string; title: string }) => boolean = (t) =>
			t.type === "page" && t.url.startsWith("app://obsidian.md/index.html"),
	): Promise<Cdp> {
		const started = Date.now();
		let wsUrl: string | undefined;
		while (!wsUrl) {
			try {
				const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
					type: string;
					url: string;
					title: string;
					webSocketDebuggerUrl: string;
				}[];
				wsUrl = targets.find(match)?.webSocketDebuggerUrl;
			} catch {
				// not up yet
			}
			if (!wsUrl) {
				if (Date.now() - started > timeoutMs) throw new Error("Obsidian window did not appear");
				await sleep(250);
			}
		}
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("CDP connection failed")));
		});
		const cdp = new Cdp(ws);
		await cdp.send("Runtime.enable");
		await cdp.send("Page.enable");
		return cdp;
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		});
	}

	/** Evaluates an async expression in the Obsidian window and returns its JSON value. */
	async eval<T = unknown>(expression: string): Promise<T> {
		const res = await this.send<{
			result: { value?: T };
			exceptionDetails?: { text: string; exception?: { description?: string } };
		}>("Runtime.evaluate", {
			expression: `(async () => { ${expression} })()`,
			awaitPromise: true,
			returnByValue: true,
		});
		if (res.exceptionDetails) {
			throw new Error(
				`Evaluation failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
			);
		}
		return res.result.value as T;
	}

	async screenshot(): Promise<Buffer> {
		const res = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		return Buffer.from(res.data, "base64");
	}

	close(): void {
		this.ws.close();
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
	description: string,
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs = 30_000,
	intervalMs = 250,
): Promise<T> {
	const started = Date.now();
	let lastError: unknown;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			lastError = e;
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Timed out waiting for: ${description}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
		}
		await sleep(intervalMs);
	}
}

export interface ObsidianInstance {
	cdp: Cdp;
	port: number;
	stop(): Promise<void>;
}

/** Launches Obsidian (under Xvfb when no display is available) with an isolated config directory. */
export async function launchObsidian(opts: {
	binary: string;
	home: string;
	vaultPath: string;
	port: number;
	logFile: string;
}): Promise<ObsidianInstance> {
	const configDir = join(opts.home, ".config", "obsidian");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "obsidian.json"),
		JSON.stringify({
			vaults: { e2evault0000001: { path: opts.vaultPath, ts: Date.now(), open: true } },
			updateDisabled: true,
		}),
	);
	const args = [opts.binary, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${opts.port}`];
	const useXvfb = !process.env.DISPLAY;
	const { openSync } = await import("node:fs");
	const out = openSync(opts.logFile, "a");
	const child: ChildProcess = spawn(useXvfb ? "xvfb-run" : args[0], useXvfb ? ["-a", ...args] : args.slice(1), {
		env: { ...process.env, HOME: opts.home, XDG_CONFIG_HOME: join(opts.home, ".config") },
		stdio: ["ignore", out, out],
		detached: true,
	});
	const cdp = await Cdp.connect(opts.port);
	return {
		cdp,
		port: opts.port,
		async stop() {
			cdp.close();
			try {
				process.kill(-child.pid!, "SIGTERM");
			} catch {
				// already gone
			}
			await sleep(500);
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// already gone
			}
		},
	};
}
