import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AZURE_API_VERSION,
	AzureBlobClient,
	AzureError,
	contentTypeFor,
	isPreconditionFailure,
	type HttpRequest,
	type HttpResponse,
} from "../../src/azure/client";
import { SyncController, type SyncStatus } from "../../src/sync/controller";
import type { SyncEngine } from "../../src/sync/engine";
import { emptyResult, type SyncResult } from "../../src/sync/types";
import { enc } from "../helpers/memory";

const conn = {
	serviceUrl: "https://acct.blob.core.windows.net",
	containerName: "vault",
	sasToken: "sv=2022-11-02&sr=c&sp=rwdl&sig=a%2Bb",
	prefix: "my vault/",
};

function response(status: number, body = "", headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, text: body, arrayBuffer: enc(body) };
}

describe("AzureBlobClient (fake transport)", () => {
	it("builds encoded URLs, sends the API version and pages through listings", async () => {
		const requests: HttpRequest[] = [];
		const pages = [
			`<EnumerationResults><Blobs><Blob><Name>my vault/a.md</Name><Properties><Etag>0x1</Etag><Content-Length>1</Content-Length></Properties></Blob></Blobs><NextMarker>m2</NextMarker></EnumerationResults>`,
			`<EnumerationResults><Blobs><Blob><Name>my vault/b.md</Name><Properties><Etag>0x2</Etag><Content-Length>2</Content-Length></Properties></Blob></Blobs><NextMarker/></EnumerationResults>`,
		];
		const client = new AzureBlobClient(conn, async (req) => {
			requests.push(req);
			return response(200, pages.shift()!);
		});
		const blobs = await client.listBlobs("my vault/");
		expect(blobs.map((b) => b.name)).toEqual(["my vault/a.md", "my vault/b.md"]);
		expect(requests).toHaveLength(2);
		const first = new URL(requests[0].url);
		expect(first.pathname).toBe("/vault");
		expect(first.searchParams.get("comp")).toBe("list");
		expect(first.searchParams.get("restype")).toBe("container");
		expect(first.searchParams.get("prefix")).toBe("my vault/");
		expect(first.searchParams.get("include")).toBe("metadata");
		expect(first.searchParams.get("sig")).toBe("a+b");
		expect(first.searchParams.has("marker")).toBe(false);
		expect(new URL(requests[1].url).searchParams.get("marker")).toBe("m2");
		expect(requests[0].headers["x-ms-version"]).toBe(AZURE_API_VERSION);

		expect(client.blobUrl("my vault/sub dir/Ä #1?.md")).toBe(
			"https://acct.blob.core.windows.net/vault/my%20vault/sub%20dir/%C3%84%20%231%3F.md?sv=2022-11-02&sr=c&sp=rwdl&sig=a%2Bb",
		);
	});

	it("sends metadata and conditions on upload", async () => {
		let seen: HttpRequest | undefined;
		const client = new AzureBlobClient(conn, async (req) => {
			seen = req;
			return response(201, "", { etag: '"0xNEW"', "last-modified": "Tue, 02 Jun 2026 11:30:00 GMT" });
		});
		const props = await client.putBlob("my vault/a.md", enc("hi"), {
			contentType: "text/markdown",
			metadata: { mtime: "5", sha256: "ff" },
			ifMatch: "0xOLD",
		});
		expect(seen!.method).toBe("PUT");
		expect(seen!.headers["x-ms-blob-type"]).toBe("BlockBlob");
		expect(seen!.headers["x-ms-meta-mtime"]).toBe("5");
		expect(seen!.headers["x-ms-meta-sha256"]).toBe("ff");
		expect(seen!.headers["If-Match"]).toBe('"0xOLD"');
		expect(seen!.headers["If-None-Match"]).toBeUndefined();
		expect(props.etag).toBe("0xNEW");
		expect(props.size).toBe(2);

		await client.putBlob("x", enc(""), { ifNoneMatchAny: true });
		expect(seen!.headers["If-None-Match"]).toBe("*");
	});

	it("retries transient failures, then maps errors to friendly messages", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const client = new AzureBlobClient(
			conn,
			async () => {
				calls++;
				if (calls === 1) throw new Error("ECONNRESET");
				if (calls === 2) return response(503, "");
				return response(
					403,
					`<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code><Message>nope</Message></Error>`,
				);
			},
			{ sleep: async (ms) => void sleeps.push(ms) },
		);
		const err = await client.probe("").catch((e) => e);
		expect(err).toBeInstanceOf(AzureError);
		expect(err.status).toBe(403);
		expect(err.code).toBe("AuthenticationFailed");
		expect(err.message).toMatch(/SAS token is invalid, expired/);
		expect(calls).toBe(3);
		expect(sleeps).toEqual([500, 1000]);
	});

	it("gives up after the retry budget on network errors", async () => {
		const client = new AzureBlobClient(
			conn,
			async () => {
				throw new Error("offline");
			},
			{ retries: 2, sleep: async () => {} },
		);
		const err = await client.getBlob("x").catch((e) => e);
		expect(err.code).toBe("NetworkError");
		expect(err.message).toMatch(/offline/);
	});

	it("delete treats 404 as already gone and detects precondition failures", async () => {
		const statuses = [404, 202, 412];
		const client = new AzureBlobClient(conn, async () =>
			response(statuses.shift()!, "", { "x-ms-error-code": "ConditionNotMet" }),
		);
		expect(await client.deleteBlob("a")).toBe(false);
		expect(await client.deleteBlob("a")).toBe(true);
		const err = await client.deleteBlob("a", { ifMatch: "0x1" }).catch((e) => e);
		expect(isPreconditionFailure(err)).toBe(true);
		expect(isPreconditionFailure(new AzureError("x", 409, "BlobAlreadyExists"))).toBe(true);
		expect(isPreconditionFailure(new AzureError("x", 409, "ContainerBeingDeleted"))).toBe(false);
		expect(isPreconditionFailure(new Error("x"))).toBe(false);
	});

	it("reads blob properties and metadata from headers", async () => {
		const client = new AzureBlobClient(conn, async () => ({
			status: 200,
			headers: {
				etag: '"0xABC"',
				"last-modified": "Tue, 02 Jun 2026 11:30:00 GMT",
				"content-length": "3",
				"x-ms-meta-mtime": "42",
				"x-ms-meta-sha256": "dead",
			},
			text: "abc",
			arrayBuffer: enc("abc"),
		}));
		const { data, properties } = await client.getBlob("a");
		expect(new TextDecoder().decode(data)).toBe("abc");
		expect(properties).toEqual({
			etag: "0xABC",
			lastModified: Date.parse("Tue, 02 Jun 2026 11:30:00 GMT"),
			size: 3,
			metadata: { mtime: "42", sha256: "dead" },
		});
	});

	it("uploads large data in blocks and commits them with the conditions", async () => {
		const requests: HttpRequest[] = [];
		const client = new AzureBlobClient(
			conn,
			async (req) => {
				requests.push(req);
				return response(201, "", { etag: '"0xNEW"' });
			},
			{ chunkSize: 4 },
		);
		const props = await client.putBlob("my vault/big.cbr", enc("0123456789"), {
			contentType: "application/x-cbr",
			metadata: { mtime: "5" },
			ifNoneMatchAny: true,
		});
		expect(props).toMatchObject({ etag: "0xNEW", size: 10, metadata: { mtime: "5" } });

		const blocks = requests.slice(0, 3);
		expect(blocks.map((r) => new TextDecoder().decode(r.body))).toEqual(["0123", "4567", "89"]);
		const ids = blocks.map((r) => {
			const url = new URL(r.url);
			expect(url.pathname).toBe("/vault/my%20vault/big.cbr");
			expect(url.searchParams.get("comp")).toBe("block");
			expect(url.searchParams.get("sig")).toBe("a+b");
			// Conditions and metadata only apply to the commit.
			expect(r.headers["If-None-Match"]).toBeUndefined();
			expect(r.headers["x-ms-meta-mtime"]).toBeUndefined();
			return url.searchParams.get("blockid")!;
		});
		expect(new Set(ids.map((id) => id.length)).size).toBe(1);
		expect(new Set(ids).size).toBe(3);

		const commit = requests[3];
		expect(requests).toHaveLength(4);
		expect(new URL(commit.url).searchParams.get("comp")).toBe("blocklist");
		expect(commit.headers["x-ms-blob-content-type"]).toBe("application/x-cbr");
		expect(commit.headers["x-ms-meta-mtime"]).toBe("5");
		expect(commit.headers["If-None-Match"]).toBe("*");
		expect(commit.headers["x-ms-blob-type"]).toBeUndefined();
		expect(new TextDecoder().decode(commit.body)).toContain(
			`<BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join("")}</BlockList>`,
		);

		// Another upload of the same path uses fresh block IDs.
		requests.length = 0;
		await client.putBlob("my vault/big.cbr", enc("0123456789"));
		expect(new URL(requests[0].url).searchParams.get("blockid")).not.toBe(ids[0]);

		// Data that fits in one chunk is a single Put Blob.
		requests.length = 0;
		await client.putBlob("small.md", enc("0123"));
		expect(requests).toHaveLength(1);
		expect(requests[0].headers["x-ms-blob-type"]).toBe("BlockBlob");
		expect(new URL(requests[0].url).searchParams.has("comp")).toBe(false);
	});

	it("downloads large blobs in ranges pinned to the first ETag", async () => {
		const content = "0123456789";
		let etag = '"0x1"';
		const requests: HttpRequest[] = [];
		const client = new AzureBlobClient(
			conn,
			async (req) => {
				requests.push(req);
				if (req.headers["If-Match"] && req.headers["If-Match"] !== etag) {
					return response(412, "", { "x-ms-error-code": "ConditionNotMet" });
				}
				const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers["x-ms-range"] ?? "");
				if (!range) return response(200, content, { etag });
				const start = Number(range[1]);
				const end = Math.min(Number(range[2]), content.length - 1);
				return response(206, content.slice(start, end + 1), {
					etag,
					"content-length": String(end - start + 1),
					"content-range": `bytes ${start}-${end}/${content.length}`,
					"x-ms-meta-mtime": "42",
				});
			},
			{ chunkSize: 4 },
		);
		const { data, properties } = await client.getBlob("big.cbr");
		expect(new TextDecoder().decode(data)).toBe(content);
		expect(properties).toMatchObject({ etag: "0x1", size: 10, metadata: { mtime: "42" } });
		expect(requests.map((r) => r.headers["x-ms-range"])).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-9"]);
		expect(requests.map((r) => r.headers["If-Match"])).toEqual([undefined, '"0x1"', '"0x1"']);

		// Replaced between two ranges: fail instead of mixing versions.
		requests.length = 0;
		const original = client.getBlob("big.cbr");
		etag = '"0x2"';
		const err = await original.catch((e) => e);
		expect(isPreconditionFailure(err)).toBe(true);
	});

	it("downloads an empty blob although the range can't be satisfied", async () => {
		const ranges: (string | undefined)[] = [];
		const client = new AzureBlobClient(conn, async (req) => {
			ranges.push(req.headers["x-ms-range"]);
			return req.headers["x-ms-range"]
				? response(416, "", { "x-ms-error-code": "InvalidRange" })
				: response(200, "", { etag: '"0x1"', "content-length": "0" });
		});
		const { data, properties } = await client.getBlob("empty.md");
		expect(data.byteLength).toBe(0);
		expect(properties.size).toBe(0);
		expect(ranges).toEqual([`bytes=0-${4 * 1024 * 1024 - 1}`, undefined]);
	});

	it("content types", () => {
		expect(contentTypeFor("a/b.MD")).toMatch(/text\/markdown/);
		expect(contentTypeFor("x.png")).toBe("image/png");
		expect(contentTypeFor("noext")).toBe("application/octet-stream");
	});
});

describe("SyncController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakeEngine() {
		const pushes: string[][] = [];
		let fulls = 0;
		let nextPush: Partial<SyncResult> = {};
		let fullGate: Promise<void> | null = null;
		const engine = {
			pushPaths: vi.fn(async (paths: string[]) => {
				pushes.push(paths);
				const r = { ...emptyResult(), ...nextPush };
				nextPush = {};
				return r;
			}),
			fullSync: vi.fn(async () => {
				fulls++;
				if (fullGate) await fullGate;
				return emptyResult();
			}),
		};
		return {
			engine: engine as unknown as SyncEngine,
			pushes,
			get fulls() {
				return fulls;
			},
			setNextPush(r: Partial<SyncResult>) {
				nextPush = r;
			},
			gate() {
				let release!: () => void;
				fullGate = new Promise((r) => (release = r));
				return () => {
					fullGate = null;
					release();
				};
			},
		};
	}

	function controller(engine: SyncEngine | { error: string }, delayMs = 1000) {
		const statuses: SyncStatus[] = [];
		const results: string[] = [];
		const c = new SyncController({
			getEngine: () => engine,
			pushDelayMs: () => delayMs,
			onStatus: (s) => statuses.push(s),
			onResult: (_r, t) => results.push(t),
			onError: () => {},
			// Node has no window timers; these are faked by vi.useFakeTimers().
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		});
		return { c, statuses, results };
	}

	it("debounces and batches local changes", async () => {
		const f = fakeEngine();
		const { c } = controller(f.engine);
		c.notifyChange("a.md");
		await vi.advanceTimersByTimeAsync(500);
		c.notifyChange("b.md", "a.md");
		await vi.advanceTimersByTimeAsync(900);
		expect(f.pushes).toEqual([]);
		await vi.advanceTimersByTimeAsync(200);
		expect(f.pushes).toEqual([["a.md", "b.md"]]);
	});

	it("uploads at least every max-wait during continuous editing", async () => {
		const f = fakeEngine();
		const { c } = controller(f.engine, 1000);
		for (let i = 0; i < 30; i++) {
			c.notifyChange("typing.md");
			await vi.advanceTimersByTimeAsync(800);
		}
		// 24s of continuous edits with a 1s debounce: max-wait (20s) forced an upload
		expect(f.pushes.length).toBeGreaterThanOrEqual(1);
	});

	it("follows a lost race with a full sync", async () => {
		const f = fakeEngine();
		const { c, results } = controller(f.engine);
		f.setNextPush({ needsResync: true });
		c.notifyChange("x.md");
		await vi.advanceTimersByTimeAsync(1000);
		await vi.runAllTimersAsync();
		expect(f.fulls).toBe(1);
		expect(results).toEqual(["push", "resync"]);
	});

	it("coalesces overlapping full sync requests", async () => {
		const f = fakeEngine();
		const { c } = controller(f.engine);
		const release = f.gate();
		const p1 = c.requestFullSync("poll");
		const p2 = c.requestFullSync("poll");
		const p3 = c.requestFullSync("manual");
		expect(c.isSyncing).toBe(true);
		release();
		await Promise.all([p1, p2, p3]);
		// One running + one queued follow-up, not three.
		expect(f.fulls).toBe(2);
		expect(c.isSyncing).toBe(false);
	});

	it("reports an unconfigured connection instead of syncing", async () => {
		const { c, statuses } = controller({ error: "SAS token is not set." });
		expect(await c.requestFullSync("startup")).toBeNull();
		expect(statuses).toEqual([{ kind: "unconfigured", message: "SAS token is not set." }]);
	});

	it("stops after dispose", async () => {
		const f = fakeEngine();
		const { c } = controller(f.engine);
		c.notifyChange("a.md");
		c.dispose();
		await vi.runAllTimersAsync();
		expect(f.pushes).toEqual([]);
		expect(await c.requestFullSync("poll")).toBeNull();
	});
});
