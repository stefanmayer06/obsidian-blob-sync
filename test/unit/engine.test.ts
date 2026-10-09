import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_OPTIONS, SyncEngine, type SyncEngineOptions } from "../../src/sync/engine";
import { createPathFilter } from "../../src/sync/filter";
import { emptyState, type SyncState } from "../../src/sync/types";
import { Clock, MemoryLocalFs, MemoryRemoteStore, enc } from "../helpers/memory";

const filter = createPathFilter({
	configDir: ".obsidian",
	pluginDir: ".obsidian/plugins/azure-blob-sync",
	syncConfigDir: false,
	ignorePatterns: ["*.tmp"],
});

function device(remote: MemoryRemoteStore, clock: Clock, opts: Partial<SyncEngineOptions> = {}) {
	const fs = new MemoryLocalFs(clock);
	const state: SyncState = emptyState("test");
	const saved: SyncState[] = [];
	const engine = new SyncEngine(
		fs,
		remote,
		state,
		{
			...DEFAULT_ENGINE_OPTIONS,
			isSyncable: filter,
			now: () => new Date(2026, 0, 31, 13, 45, 12),
			...opts,
		},
		async (s) => {
			saved.push(JSON.parse(JSON.stringify(s)));
		},
	);
	return { fs, engine, state, saved };
}

function setup(opts: Partial<SyncEngineOptions> = {}) {
	const clock = new Clock();
	const remote = new MemoryRemoteStore(clock);
	const a = device(remote, clock, opts);
	const b = device(remote, clock, opts);
	return { clock, remote, a, b };
}

describe("SyncEngine – basic propagation", () => {
	it("uploads a new vault, then is a no-op", async () => {
		const { remote, a } = setup();
		a.fs.set("Note.md", "hello");
		a.fs.set("folder/Sub note.md", "sub");
		a.fs.set("img/pic.png", enc("\u0000\u0001binary"));

		const r1 = await a.engine.fullSync();
		expect(r1.uploaded.sort()).toEqual(["Note.md", "folder/Sub note.md", "img/pic.png"]);
		expect(r1.errors).toEqual([]);
		expect(remote.get("Note.md")).toBe("hello");
		expect(Object.keys(a.state.files).sort()).toEqual(["Note.md", "folder/Sub note.md", "img/pic.png"]);
		expect(a.saved.length).toBeGreaterThan(0);

		const uploadsBefore = remote.calls.upload;
		const r2 = await a.engine.fullSync();
		expect(r2.uploaded).toEqual([]);
		expect(r2.downloaded).toEqual([]);
		expect(remote.calls.upload).toBe(uploadsBefore);
		expect(remote.calls.download).toBe(0);
	});

	it("downloads everything to a new device and keeps the modification time", async () => {
		const { a, b } = setup();
		a.fs.set("Note.md", "hello", 1_600_000_000_000);
		await a.engine.fullSync();

		const r = await b.engine.fullSync();
		expect(r.downloaded).toEqual(["Note.md"]);
		expect(b.fs.get("Note.md")).toBe("hello");
		expect(b.fs.files.get("Note.md")!.mtime).toBe(1_600_000_000_000);

		const again = await b.engine.fullSync();
		expect(again.downloaded).toEqual([]);
		expect(again.uploaded).toEqual([]);
	});

	it("propagates edits and deletions in both directions", async () => {
		const { remote, a, b } = setup();
		a.fs.set("one.md", "1");
		a.fs.set("two.md", "2");
		await a.engine.fullSync();
		await b.engine.fullSync();

		// Edit on A, push via live path
		a.fs.set("one.md", "1 edited on A");
		const push = await a.engine.pushPaths(["one.md"]);
		expect(push.uploaded).toEqual(["one.md"]);
		expect(push.needsResync).toBe(false);

		// Delete on B
		b.fs.remove("two.md");
		const pushB = await b.engine.pushPaths(["two.md"]);
		expect(pushB.deletedRemote).toEqual(["two.md"]);
		expect(remote.blobs.has("two.md")).toBe(false);

		const rb = await b.engine.fullSync();
		expect(rb.downloaded).toEqual(["one.md"]);
		expect(b.fs.get("one.md")).toBe("1 edited on A");

		const ra = await a.engine.fullSync();
		expect(ra.deletedLocal).toEqual(["two.md"]);
		expect(a.fs.trash).toEqual(["two.md"]);
		expect(a.state.files["two.md"]).toBeUndefined();
	});

	it("does not upload when only the modification time changed", async () => {
		const { remote, a } = setup();
		a.fs.set("a.md", "same");
		await a.engine.fullSync();
		a.fs.touch("a.md");
		const uploads = remote.calls.upload;
		const r = await a.engine.pushPaths(["a.md"]);
		expect(r.uploaded).toEqual([]);
		expect(remote.calls.upload).toBe(uploads);
		expect(a.state.files["a.md"].mtime).toBe(a.fs.files.get("a.md")!.mtime);
	});

	it("handles renames as delete + create", async () => {
		const { remote, a, b } = setup();
		a.fs.set("old.md", "content");
		await a.engine.fullSync();
		await b.engine.fullSync();
		const f = a.fs.files.get("old.md")!;
		a.fs.files.delete("old.md");
		a.fs.files.set("new.md", f);
		const r = await a.engine.pushPaths(["new.md", "old.md"]);
		expect(r.uploaded).toEqual(["new.md"]);
		expect(r.deletedRemote).toEqual(["old.md"]);
		expect([...remote.blobs.keys()]).toEqual(["new.md"]);
		const rb = await b.engine.fullSync();
		expect(rb.downloaded).toEqual(["new.md"]);
		expect(rb.deletedLocal).toEqual(["old.md"]);
	});
});

describe("SyncEngine – first sync of two existing vaults", () => {
	it("records identical files without transferring them", async () => {
		const { remote, a, b } = setup();
		a.fs.set("same.md", "identical");
		a.fs.set("only-a.md", "a");
		await a.engine.fullSync();
		b.fs.set("same.md", "identical");
		b.fs.set("only-b.md", "b");
		const downloadsBefore = remote.calls.download;
		const r = await b.engine.fullSync();
		expect(r.uploaded).toEqual(["only-b.md"]);
		expect(r.downloaded).toEqual(["only-a.md"]);
		expect(r.conflicts).toEqual([]);
		expect(remote.calls.download - downloadsBefore).toBe(1);
		expect(b.state.files["same.md"]).toBeDefined();
	});

	it("compares content when the remote blob has no hash metadata", async () => {
		const { remote, b } = setup();
		await remote.putExternal("x.md", "external", false);
		b.fs.set("x.md", "external");
		const r = await b.engine.fullSync();
		expect(r.conflicts).toEqual([{ path: "x.md", resolution: "identical" }]);
		expect(r.uploaded).toEqual([]);
		expect(b.fs.files.size).toBe(1);
	});
});

describe("SyncEngine – conflicts", () => {
	async function conflicted(opts: Partial<SyncEngineOptions> = {}) {
		const ctx = setup(opts);
		ctx.a.fs.set("n.md", "base");
		await ctx.a.engine.fullSync();
		await ctx.b.engine.fullSync();
		ctx.a.fs.set("n.md", "edited on A");
		await ctx.a.engine.pushPaths(["n.md"]);
		ctx.b.fs.set("n.md", "edited on B");
		return ctx;
	}

	it("keep-both saves the remote version as a conflict copy on both sides", async () => {
		const { remote, a, b } = await conflicted();
		const r = await b.engine.fullSync();
		const copy = "n (conflict 2026-01-31 13-45-12).md";
		expect(r.conflicts).toEqual([{ path: "n.md", resolution: "kept-both", conflictCopy: copy }]);
		expect(b.fs.get("n.md")).toBe("edited on B");
		expect(b.fs.get(copy)).toBe("edited on A");
		expect(remote.get("n.md")).toBe("edited on B");
		expect(remote.get(copy)).toBe("edited on A");

		const ra = await a.engine.fullSync();
		expect(ra.downloaded.sort()).toEqual([copy, "n.md"].sort());
		expect(a.fs.get("n.md")).toBe("edited on B");
		expect(a.fs.get(copy)).toBe("edited on A");

		// Stable afterwards
		const again = await b.engine.fullSync();
		expect(again.uploaded.length + again.downloaded.length + again.conflicts.length).toBe(0);
	});

	it("keep-both picks a free name if a conflict copy already exists", async () => {
		const { b } = await conflicted();
		b.fs.set("n (conflict 2026-01-31 13-45-12).md", "older conflict copy");
		const r = await b.engine.fullSync();
		const c = r.conflicts.find((x) => x.path === "n.md")!;
		expect(c.conflictCopy).toBe("n (conflict 2026-01-31 13-45-12 2).md");
		expect(b.fs.get("n (conflict 2026-01-31 13-45-12).md")).toBe("older conflict copy");
	});

	it("local-wins overwrites the remote", async () => {
		const { remote, b } = await conflicted({ conflictStrategy: "local-wins" });
		const r = await b.engine.fullSync();
		expect(r.conflicts[0].resolution).toBe("local");
		expect(remote.get("n.md")).toBe("edited on B");
		expect(b.fs.files.size).toBe(1);
	});

	it("remote-wins overwrites the local file", async () => {
		const { b } = await conflicted({ conflictStrategy: "remote-wins" });
		const r = await b.engine.fullSync();
		expect(r.conflicts[0].resolution).toBe("remote");
		expect(b.fs.get("n.md")).toBe("edited on A");
	});

	it("newest-wins compares modification times", async () => {
		const { b } = await conflicted({ conflictStrategy: "newest-wins" });
		// B edited last, so B wins
		const r = await b.engine.fullSync();
		expect(r.conflicts[0].resolution).toBe("local");
	});

	it("per-path strategy override is honoured", async () => {
		const { b } = await conflicted({ conflictStrategyFor: () => "remote-wins" });
		const r = await b.engine.fullSync();
		expect(r.conflicts[0].resolution).toBe("remote");
	});

	it("an edit wins over a deletion on the other side", async () => {
		const { remote, a, b } = setup();
		a.fs.set("keep.md", "v1");
		a.fs.set("keep2.md", "v1");
		await a.engine.fullSync();
		await b.engine.fullSync();
		// A deletes keep.md, B edits it
		a.fs.remove("keep.md");
		await a.engine.pushPaths(["keep.md"]);
		b.fs.set("keep.md", "v2 from B");
		const rb = await b.engine.fullSync();
		expect(rb.uploaded).toEqual(["keep.md"]);
		expect(remote.get("keep.md")).toBe("v2 from B");

		// B deletes keep2.md, A edits it before syncing
		b.fs.remove("keep2.md");
		await b.engine.pushPaths(["keep2.md"]);
		a.fs.set("keep2.md", "v2 from A");
		const ra = await a.engine.fullSync();
		expect(ra.uploaded.sort()).toEqual(["keep2.md"]);
		expect(ra.downloaded).toEqual(["keep.md"]);
		expect(remote.get("keep2.md")).toBe("v2 from A");
	});

	it("a remote edit wins over a local deletion", async () => {
		const { a, b } = setup();
		a.fs.set("x.md", "v1");
		await a.engine.fullSync();
		await b.engine.fullSync();
		a.fs.set("x.md", "v2");
		await a.engine.pushPaths(["x.md"]);
		b.fs.remove("x.md"); // deleted on B, but B didn't push yet
		const r = await b.engine.fullSync();
		expect(r.downloaded).toEqual(["x.md"]);
		expect(b.fs.get("x.md")).toBe("v2");
	});
});

describe("SyncEngine – races and safety", () => {
	it("a push with a stale ETag does not overwrite and asks for a resync", async () => {
		const { remote, a, b } = setup();
		a.fs.set("r.md", "base");
		await a.engine.fullSync();
		await b.engine.fullSync();
		b.fs.set("r.md", "B");
		await b.engine.pushPaths(["r.md"]);
		a.fs.set("r.md", "A");
		const push = await a.engine.pushPaths(["r.md"]);
		expect(push.needsResync).toBe(true);
		expect(push.uploaded).toEqual([]);
		expect(remote.get("r.md")).toBe("B");
		// The follow-up full sync resolves it as a conflict
		const full = await a.engine.fullSync();
		expect(full.conflicts[0].resolution).toBe("kept-both");
	});

	it("new file created on both devices before syncing is not overwritten by a push", async () => {
		const { remote, a, b } = setup();
		a.fs.set("new.md", "from A");
		await a.engine.pushPaths(["new.md"]);
		b.fs.set("new.md", "from B");
		const push = await b.engine.pushPaths(["new.md"]);
		expect(push.needsResync).toBe(true);
		expect(remote.get("new.md")).toBe("from A");
	});

	it("does not overwrite a local file edited while the sync was running", async () => {
		const { a, b } = setup();
		a.fs.set("e.md", "v1");
		await a.engine.fullSync();
		await b.engine.fullSync();
		a.fs.set("e.md", "v2 remote");
		await a.engine.pushPaths(["e.md"]);
		b.fs.afterList = () => {
			b.fs.set("e.md", "typed during sync");
			b.fs.afterList = undefined;
		};
		const r = await b.engine.fullSync();
		expect(r.needsResync).toBe(true);
		expect(b.fs.get("e.md")).toBe("typed during sync");
	});

	it("holds back mass deletions until confirmed", async () => {
		const { remote, a } = setup();
		for (let i = 0; i < 20; i++) a.fs.set(`n${i}.md`, `note ${i}`);
		await a.engine.fullSync();
		remote.blobs.clear(); // e.g. someone emptied the container
		const r = await a.engine.fullSync();
		expect(r.blockedDeletions.local).toHaveLength(20);
		expect(r.deletedLocal).toEqual([]);
		expect(a.fs.files.size).toBe(20);

		const confirmed = await a.engine.fullSync({ allowMassDelete: true });
		expect(confirmed.deletedLocal).toHaveLength(20);
		expect(a.fs.files.size).toBe(0);
	});

	it("declined mass deletions are restored instead", async () => {
		const { remote, a } = setup();
		for (let i = 0; i < 20; i++) a.fs.set(`n${i}.md`, `note ${i}`);
		await a.engine.fullSync();
		remote.blobs.clear();
		const r = await a.engine.fullSync();
		await a.engine.forgetPaths([...r.blockedDeletions.local, "never-synced.md"]);
		const restored = await a.engine.fullSync();
		expect(restored.uploaded).toHaveLength(20);
		expect(restored.blockedDeletions.local).toEqual([]);
		expect(remote.blobs.size).toBe(20);
	});

	it("small deletions are not held back", async () => {
		const { remote, a } = setup();
		for (let i = 0; i < 20; i++) a.fs.set(`n${i}.md`, `note ${i}`);
		await a.engine.fullSync();
		remote.blobs.delete("n1.md");
		remote.blobs.delete("n2.md");
		const r = await a.engine.fullSync();
		expect(r.deletedLocal.sort()).toEqual(["n1.md", "n2.md"]);
	});

	it("never syncs ignored or hidden files, and forgets newly ignored ones without deleting", async () => {
		const { remote, a } = setup();
		a.fs.set("keep.md", "k");
		a.fs.set("scratch.tmp", "t");
		a.fs.set(".trash/old.md", "o");
		a.fs.set(".obsidian/app.json", "{}");
		a.fs.set("drafts/d.md", "d");
		await a.engine.fullSync();
		expect([...remote.blobs.keys()].sort()).toEqual(["drafts/d.md", "keep.md"]);

		a.engine.updateOptions({
			isSyncable: createPathFilter({
				configDir: ".obsidian",
				pluginDir: ".obsidian/plugins/azure-blob-sync",
				syncConfigDir: false,
				ignorePatterns: ["drafts/"],
			}),
		});
		const r = await a.engine.fullSync();
		expect(r.deletedRemote).toEqual([]);
		expect(r.deletedLocal).toEqual([]);
		expect(remote.blobs.has("drafts/d.md")).toBe(true);
		expect(a.state.files["drafts/d.md"]).toBeUndefined();
	});

	it("skips files over the size limit", async () => {
		const { remote, a } = setup({ maxFileSize: 10 });
		a.fs.set("small.md", "tiny");
		a.fs.set("big.pdf", "x".repeat(100));
		const r = await a.engine.fullSync();
		expect(r.uploaded).toEqual(["small.md"]);
		expect(r.skipped.map((s) => s.path)).toEqual(["big.pdf"]);
		expect(remote.blobs.has("big.pdf")).toBe(false);
	});

	it("reports per-file errors and keeps going", async () => {
		const { remote, a } = setup();
		a.fs.set("ok.md", "ok");
		a.fs.set("bad.md", "bad");
		const original = remote.upload.bind(remote);
		remote.upload = async (path, data, o) => {
			if (path === "bad.md") throw new Error("boom");
			return original(path, data, o);
		};
		const r = await a.engine.fullSync();
		expect(r.uploaded).toEqual(["ok.md"]);
		expect(r.errors).toEqual([{ path: "bad.md", message: "boom" }]);
		expect(a.state.files["bad.md"]).toBeUndefined();
	});
});

describe("SyncEngine – one-way modes", () => {
	it("upload-only never changes local files and only deletes blobs it tracked", async () => {
		const clock = new Clock();
		const remote = new MemoryRemoteStore(clock);
		const a = device(remote, clock, { direction: "upload-only" });
		a.fs.set("a.md", "A");
		a.fs.set("b.md", "B");
		await remote.putExternal("foreign.md", "not ours");
		const r1 = await a.engine.fullSync();
		expect(r1.uploaded.sort()).toEqual(["a.md", "b.md"]);
		expect(r1.downloaded).toEqual([]);
		expect(a.fs.files.has("foreign.md")).toBe(false);

		await remote.putExternal("a.md", "changed remotely");
		a.fs.remove("b.md");
		const r2 = await a.engine.fullSync();
		expect(r2.uploaded).toEqual(["a.md"]);
		expect(remote.get("a.md")).toBe("A");
		expect(r2.deletedRemote).toEqual(["b.md"]);
		expect(remote.blobs.has("foreign.md")).toBe(true);
	});

	it("download-only mirrors the container and never uploads", async () => {
		const clock = new Clock();
		const remote = new MemoryRemoteStore(clock);
		const a = device(remote, clock, { direction: "download-only" });
		await remote.putExternal("r.md", "remote");
		a.fs.set("local-only.md", "mine");
		const r1 = await a.engine.fullSync();
		expect(r1.downloaded).toEqual(["r.md"]);
		expect(r1.uploaded).toEqual([]);
		expect(remote.blobs.has("local-only.md")).toBe(false);

		a.fs.set("r.md", "local edit");
		const push = await a.engine.pushPaths(["r.md"]);
		expect(push.uploaded).toEqual([]);
		const r2 = await a.engine.fullSync();
		expect(r2.downloaded).toEqual(["r.md"]);
		expect(a.fs.get("r.md")).toBe("remote");

		remote.blobs.delete("r.md");
		const r3 = await a.engine.fullSync();
		expect(r3.deletedLocal).toEqual(["r.md"]);
		expect(a.fs.get("local-only.md")).toBe("mine");
	});
});
