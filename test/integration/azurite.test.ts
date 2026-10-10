import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureBlobClient, AzureError, isPreconditionFailure } from "../../src/azure/client";
import { parseSasUrl, resolveConnection, validateSasToken } from "../../src/azure/sas";
import { AzureRemoteStore } from "../../src/sync/azure-remote";
import { DEFAULT_ENGINE_OPTIONS, SyncEngine } from "../../src/sync/engine";
import { createPathFilter } from "../../src/sync/filter";
import { RemoteConflictError, emptyState } from "../../src/sync/types";
import { sha256Hex } from "../../src/sync/util";
import { fetchHttp, nodeSleep, startAzurite, type Azurite } from "../helpers/azurite";
import { Clock, MemoryLocalFs, dec, enc } from "../helpers/memory";

let azurite: Azurite;
let containerSeq = 0;

beforeAll(async () => {
	azurite = await startAzurite();
}, 30_000);

afterAll(async () => {
	await azurite?.stop();
});

async function newContainer(permissions = "racwdl") {
	const name = `vault${++containerSeq}${Date.now().toString(36)}`;
	const sas = await azurite.createContainer(name, permissions);
	return { name, sas };
}

function clientFor(container: string, sas: string, prefix = "") {
	const conn = resolveConnection({
		accountName: "",
		containerName: container,
		sasToken: sas,
		serviceUrl: azurite.serviceUrl,
		remotePrefix: prefix,
	});
	return new AzureBlobClient(conn, fetchHttp, { retries: 0 });
}

describe("AzureBlobClient against Azurite", () => {
	it("accepts a pasted SAS URL", async () => {
		const { name, sas } = await newContainer();
		expect(validateSasToken(sas)).toEqual([]);
		const parsed = parseSasUrl(`${azurite.serviceUrl}/${name}?${sas}`);
		expect(parsed.containerName).toBe(name);
		expect(parsed.serviceUrl).toBe(azurite.serviceUrl);
		const conn = resolveConnection({
			accountName: parsed.accountName ?? "",
			containerName: parsed.containerName!,
			sasToken: parsed.sasToken!,
			serviceUrl: parsed.serviceUrl!,
			remotePrefix: parsed.remotePrefix ?? "",
		});
		const client = new AzureBlobClient(conn, fetchHttp, { sleep: nodeSleep });
		await client.probe("");
	});

	it("uploads, lists, downloads and deletes with metadata", async () => {
		const { name, sas } = await newContainer();
		const client = clientFor(name, sas);
		const data = enc("# Hello\nworld");
		const put = await client.putBlob("notes/hello.md", data, {
			contentType: "text/markdown",
			metadata: { mtime: "1700000000000", sha256: await sha256Hex(data) },
		});
		expect(put.etag).toMatch(/^0x/);

		const listed = await client.listBlobs("");
		expect(listed).toHaveLength(1);
		expect(listed[0].name).toBe("notes/hello.md");
		expect(listed[0].etag).toBe(put.etag);
		expect(listed[0].size).toBe(data.byteLength);
		expect(listed[0].metadata.mtime).toBe("1700000000000");
		expect(listed[0].metadata.sha256).toBe(await sha256Hex(data));

		const got = await client.getBlob("notes/hello.md");
		expect(dec(got.data)).toBe("# Hello\nworld");
		expect(got.properties.etag).toBe(put.etag);
		expect(got.properties.metadata.mtime).toBe("1700000000000");

		expect(await client.deleteBlob("notes/hello.md")).toBe(true);
		expect(await client.deleteBlob("notes/hello.md")).toBe(false);
		expect(await client.listBlobs("")).toEqual([]);
	});

	it("round-trips awkward file names, empty and binary files", async () => {
		const { name, sas } = await newContainer();
		const client = clientFor(name, sas);
		const names = [
			"Daily Notes/2026-10-09.md",
			"Ünïcødé/Ärger & Öl.md",
			"symbols/100% #tag ?q=1 +plus [x] (y) {z} ~tilde 'quote'.md",
			"emoji/📝 notes.md",
			"deep/a/b/c/d/e/f/g.md",
		];
		for (const n of names) await client.putBlob(n, enc(`content of ${n}`));
		await client.putBlob("empty.md", new ArrayBuffer(0));
		const binary = randomBytes(1024 * 1024);
		const binBuf = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
		await client.putBlob("attachments/random.bin", binBuf);

		const listed = (await client.listBlobs("")).map((b) => b.name).sort();
		expect(listed).toEqual([...names, "empty.md", "attachments/random.bin"].sort());
		for (const n of names) expect(dec((await client.getBlob(n)).data)).toBe(`content of ${n}`);
		expect((await client.getBlob("empty.md")).data.byteLength).toBe(0);
		const back = new Uint8Array((await client.getBlob("attachments/random.bin")).data);
		expect(Buffer.from(back).equals(binary)).toBe(true);
	});

	it("paginates listings", async () => {
		const { name, sas } = await newContainer();
		const client = clientFor(name, sas);
		for (let i = 0; i < 7; i++) await client.putBlob(`p/${i}.md`, enc(String(i)));
		const all = await client.listBlobs("p/", 2);
		expect(all.map((b) => b.name)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `p/${i}.md`));
	});

	it("enforces ETag preconditions", async () => {
		const { name, sas } = await newContainer();
		const client = clientFor(name, sas);
		const first = await client.putBlob("c.md", enc("v1"));
		const second = await client.putBlob("c.md", enc("v2"), { ifMatch: first.etag });
		expect(second.etag).not.toBe(first.etag);

		const stale = await client.putBlob("c.md", enc("v3"), { ifMatch: first.etag }).catch((e) => e);
		expect(stale).toBeInstanceOf(AzureError);
		expect(isPreconditionFailure(stale)).toBe(true);

		const exists = await client.putBlob("c.md", enc("v3"), { ifNoneMatchAny: true }).catch((e) => e);
		expect(isPreconditionFailure(exists)).toBe(true);

		const staleDelete = await client.deleteBlob("c.md", { ifMatch: first.etag }).catch((e) => e);
		expect(isPreconditionFailure(staleDelete)).toBe(true);
		expect(dec((await client.getBlob("c.md")).data)).toBe("v2");
		expect(await client.deleteBlob("c.md", { ifMatch: second.etag })).toBe(true);
	});

	it("explains authentication and permission problems", async () => {
		const { name, sas } = await newContainer();
		const forged = sas.replace(/sig=[^&]+/, "sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D");
		const bad = await clientFor(name, forged).probe("").catch((e) => e);
		expect(bad).toBeInstanceOf(AzureError);
		expect(bad.status).toBe(403);
		expect(bad.message).toMatch(/SAS token/);

		const readOnly = azurite.sasFor(name, "rl");
		const ro = clientFor(name, readOnly);
		await ro.probe("");
		const denied = await ro.putBlob("x.md", enc("x")).catch((e) => e);
		expect(denied).toBeInstanceOf(AzureError);
		expect(denied.status).toBe(403);
		expect(denied.message).toMatch(/doesn't allow this operation|denied|SAS/);

		const expired = azurite.sasFor(name, "racwdl", -30_000);
		const exp = await clientFor(name, expired).probe("").catch((e) => e);
		expect(exp.status).toBe(403);

		const missing = await clientFor("doesnotexist", azurite.sasFor("doesnotexist", "racwdl"))
			.probe("")
			.catch((e) => e);
		expect(missing.status).toBe(404);
		expect(missing.message).toMatch(/container doesn't exist/);
	});
});

describe("Sync engine end-to-end through Azurite", () => {
	const filter = createPathFilter({
		configDir: ".obsidian",
		pluginDir: ".obsidian/plugins/azure-blob-sync",
		syncConfigDir: true,
		ignorePatterns: [],
	});

	function device(client: AzureBlobClient, clock: Clock) {
		const fs = new MemoryLocalFs(clock);
		const state = emptyState("it");
		const engine = new SyncEngine(
			fs,
			new AzureRemoteStore(client),
			state,
			{ ...DEFAULT_ENGINE_OPTIONS, isSyncable: filter, now: () => new Date(2026, 9, 9, 12, 0, 0) },
			async () => {},
		);
		return { fs, state, engine };
	}

	it("keeps two devices in sync", async () => {
		const { name, sas } = await newContainer();
		const clock = new Clock();
		const laptop = device(clientFor(name, sas, "vaults/main"), clock);
		const phone = device(clientFor(name, sas, "vaults/main"), clock);

		laptop.fs.set("Welcome.md", "# Welcome");
		laptop.fs.set("Projects/Plan.md", "- [ ] ship it");
		laptop.fs.set("assets/logo.png", randomBytes(5000).buffer as ArrayBuffer);
		laptop.fs.set(".obsidian/app.json", '{"theme":"dark"}');
		laptop.fs.set(".obsidian/workspace.json", "{}"); // never synced
		laptop.fs.set(".trash/old.md", "old"); // never synced

		const r1 = await laptop.engine.fullSync();
		expect(r1.errors).toEqual([]);
		expect(r1.uploaded.sort()).toEqual([".obsidian/app.json", "Projects/Plan.md", "Welcome.md", "assets/logo.png"]);

		// Blobs are stored under the prefix with metadata
		const raw = await clientFor(name, sas).listBlobs("");
		expect(raw.map((b) => b.name).sort()).toEqual(
			[".obsidian/app.json", "Projects/Plan.md", "Welcome.md", "assets/logo.png"].map((p) => `vaults/main/${p}`).sort(),
		);
		expect(raw.every((b) => /^[0-9a-f]{64}$/.test(b.metadata.sha256))).toBe(true);

		const r2 = await phone.engine.fullSync();
		expect(r2.downloaded.sort()).toEqual(r1.uploaded.sort());
		expect(phone.fs.get("Projects/Plan.md")).toBe("- [ ] ship it");
		expect(phone.fs.files.get("Welcome.md")!.mtime).toBe(laptop.fs.files.get("Welcome.md")!.mtime);

		// Live edits on the phone
		phone.fs.set("Projects/Plan.md", "- [x] ship it");
		phone.fs.set("Inbox/idea.md", "new idea");
		phone.fs.remove("Welcome.md");
		const push = await phone.engine.pushPaths(["Projects/Plan.md", "Inbox/idea.md", "Welcome.md"]);
		expect(push.errors).toEqual([]);
		expect(push.uploaded.sort()).toEqual(["Inbox/idea.md", "Projects/Plan.md"]);
		expect(push.deletedRemote).toEqual(["Welcome.md"]);

		const r3 = await laptop.engine.fullSync();
		expect(r3.downloaded.sort()).toEqual(["Inbox/idea.md", "Projects/Plan.md"]);
		expect(r3.deletedLocal).toEqual(["Welcome.md"]);
		expect(laptop.fs.get("Projects/Plan.md")).toBe("- [x] ship it");

		// Concurrent edits: conflict copy on both devices
		laptop.fs.set("Inbox/idea.md", "laptop version");
		phone.fs.set("Inbox/idea.md", "phone version");
		const lp = await laptop.engine.pushPaths(["Inbox/idea.md"]);
		expect(lp.uploaded).toEqual(["Inbox/idea.md"]);
		const pp = await phone.engine.pushPaths(["Inbox/idea.md"]);
		expect(pp.needsResync).toBe(true);
		const pf = await phone.engine.fullSync();
		const copy = "Inbox/idea (conflict 2026-10-09 12-00-00).md";
		expect(pf.conflicts).toEqual([{ path: "Inbox/idea.md", resolution: "kept-both", conflictCopy: copy }]);
		const lf = await laptop.engine.fullSync();
		expect(lf.downloaded.sort()).toEqual([copy, "Inbox/idea.md"].sort());
		for (const dev of [laptop, phone]) {
			expect(dev.fs.get("Inbox/idea.md")).toBe("phone version");
			expect(dev.fs.get(copy)).toBe("laptop version");
		}

		// Both converge: nothing left to do
		for (const dev of [laptop, phone]) {
			const r = await dev.engine.fullSync();
			expect(r.uploaded.length + r.downloaded.length + r.deletedLocal.length + r.deletedRemote.length).toBe(0);
		}
		expect([...laptop.fs.files.keys()].sort()).toEqual(
			[...phone.fs.files.keys()].filter((p) => p !== ".trash/old.md" && p !== ".obsidian/workspace.json").concat(
				[".obsidian/workspace.json", ".trash/old.md"],
			).sort(),
		);
	});

	it("keeps vaults with different prefixes apart and ignores folder placeholders", async () => {
		const { name, sas } = await newContainer();
		const clock = new Clock();
		const a = device(clientFor(name, sas, "personal"), clock);
		const b = device(clientFor(name, sas, "work"), clock);
		a.fs.set("a.md", "A");
		b.fs.set("b.md", "B");
		await a.engine.fullSync();
		await b.engine.fullSync();
		const root = clientFor(name, sas);
		// Placeholders like Storage Explorer / Data Lake folders create
		await root.putBlob("personal/folder/", new ArrayBuffer(0));
		await root.putBlob("personal/dir", new ArrayBuffer(0), { metadata: { hdi_isfolder: "true" } });

		const ra = await a.engine.fullSync();
		expect(ra.downloaded).toEqual([]);
		expect([...a.fs.files.keys()]).toEqual(["a.md"]);
		expect([...b.fs.files.keys()]).toEqual(["b.md"]);
	});

	it("maps lost races to RemoteConflictError", async () => {
		const { name, sas } = await newContainer();
		const store = new AzureRemoteStore(clientFor(name, sas));
		const sha = await sha256Hex(enc("x"));
		const first = await store.upload("r.md", enc("x"), { mtime: 1, sha256: sha, ifNoneMatchAny: true });
		await expect(store.upload("r.md", enc("y"), { mtime: 2, sha256: sha, ifNoneMatchAny: true })).rejects.toBeInstanceOf(
			RemoteConflictError,
		);
		await store.upload("r.md", enc("z"), { mtime: 3, sha256: sha, ifMatch: first.etag });
		await expect(store.delete("r.md", { ifMatch: first.etag })).rejects.toBeInstanceOf(RemoteConflictError);
		// If-Match against a blob that was deleted meanwhile
		await store.delete("r.md", {});
		await expect(store.upload("r.md", enc("w"), { mtime: 4, sha256: sha, ifMatch: first.etag })).rejects.toBeInstanceOf(
			RemoteConflictError,
		);
		await store.delete("never-existed.md", {});
	});
});
