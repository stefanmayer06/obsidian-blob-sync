import { describe, expect, it } from "vitest";
import { decodeXmlEntities, normalizeEtag, parseErrorXml, parseListBlobsXml } from "../../src/azure/xml";
import { createPathFilter, globToRegExp, parsePatterns } from "../../src/sync/filter";
import { Mutex, conflictCopyPath, runWithConcurrency, sha256Hex } from "../../src/sync/util";
import { enc } from "../helpers/memory";

const LIST_XML = `﻿<?xml version="1.0" encoding="utf-8"?>
<EnumerationResults ServiceEndpoint="https://acct.blob.core.windows.net/" ContainerName="vault">
  <Prefix>notes/</Prefix>
  <MaxResults>2</MaxResults>
  <Blobs>
    <Blob>
      <Name>notes/Tom &amp; Jerry &lt;3.md</Name>
      <Properties>
        <Creation-Time>Mon, 01 Jun 2026 10:00:00 GMT</Creation-Time>
        <Last-Modified>Tue, 02 Jun 2026 11:30:00 GMT</Last-Modified>
        <Etag>0x8DC0000000000001</Etag>
        <Content-Length>1234</Content-Length>
        <Content-Type>text/markdown</Content-Type>
        <Content-MD5 />
        <BlobType>BlockBlob</BlobType>
      </Properties>
      <Metadata>
        <mtime>1780000000000</mtime>
        <SHA256>abc</SHA256>
        <Name>not the blob name</Name>
      </Metadata>
    </Blob>
    <Blob>
      <Name Encoded="true">notes/odd%EF%BF%BEname.md</Name>
      <Properties>
        <Last-Modified>Tue, 02 Jun 2026 11:31:00 GMT</Last-Modified>
        <Etag>"0x8DC0000000000002"</Etag>
        <Content-Length>0</Content-Length>
      </Properties>
      <Metadata />
    </Blob>
  </Blobs>
  <NextMarker>2!80!MDAwMDE2IW5vdGVzL29kZG5hbWUubWQhMDAwMDI4ITk5OTktMTItMzFUMjM6NTk6NTkuOTk5OTk5OVoh</NextMarker>
</EnumerationResults>`;

describe("List Blobs XML parser", () => {
	it("parses names, properties, metadata and the continuation marker", () => {
		const page = parseListBlobsXml(LIST_XML);
		expect(page.blobs).toHaveLength(2);
		const [a, b] = page.blobs;
		expect(a.name).toBe("notes/Tom & Jerry <3.md");
		expect(a.etag).toBe("0x8DC0000000000001");
		expect(a.size).toBe(1234);
		expect(a.lastModified).toBe(Date.parse("Tue, 02 Jun 2026 11:30:00 GMT"));
		expect(a.metadata).toEqual({ mtime: "1780000000000", sha256: "abc", name: "not the blob name" });
		expect(b.name).toBe("notes/odd￾name.md");
		expect(b.etag).toBe("0x8DC0000000000002");
		expect(b.size).toBe(0);
		expect(b.metadata).toEqual({});
		expect(page.nextMarker).toMatch(/^2!80!/);
	});

	it("handles an empty listing", () => {
		const page = parseListBlobsXml(
			`<?xml version="1.0"?><EnumerationResults><Blobs /><NextMarker /></EnumerationResults>`,
		);
		expect(page).toEqual({ blobs: [], nextMarker: "" });
	});

	it("decodes entities and error bodies", () => {
		expect(decodeXmlEntities("&#x41;&#66;&quot;&apos;&amp;amp;")).toBe("AB\"'&amp;");
		expect(
			parseErrorXml(
				`<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code><Message>Server failed to authenticate.\nRequestId:1</Message></Error>`,
			),
		).toEqual({ code: "AuthenticationFailed", message: "Server failed to authenticate." });
		expect(normalizeEtag('W/"abc"')).toBe("abc");
		expect(normalizeEtag(undefined)).toBe("");
	});
});

describe("ignore patterns", () => {
	const filter = createPathFilter({
		configDir: ".obsidian",
		pluginDir: ".obsidian/plugins/azure-blob-sync",
		syncConfigDir: true,
		ignorePatterns: parsePatterns("# comment\n*.tmp\nPrivate/\n/Archive\nDaily/2023/**\n\nsecret?.md"),
	});

	it("applies user patterns", () => {
		expect(filter("note.md")).toBe(true);
		expect(filter("a/b/c.tmp")).toBe(false);
		expect(filter("Private/x.md")).toBe(false);
		expect(filter("Work/Private/x.md")).toBe(false);
		expect(filter("PrivateNotes/x.md")).toBe(true);
		expect(filter("Archive/old.md")).toBe(false);
		expect(filter("Work/Archive/old.md")).toBe(true);
		expect(filter("Daily/2023/01/01.md")).toBe(false);
		expect(filter("Daily/2024/01/01.md")).toBe(true);
		expect(filter("secret1.md")).toBe(false);
		expect(filter("secret12.md")).toBe(true);
	});

	it("excludes hidden files, workspace files and the plugin's own folder", () => {
		expect(filter(".trash/x.md")).toBe(false);
		expect(filter("folder/.DS_Store")).toBe(false);
		expect(filter(".git/config")).toBe(false);
		expect(filter(".obsidian/app.json")).toBe(true);
		expect(filter(".obsidian/plugins/dataview/main.js")).toBe(true);
		expect(filter(".obsidian/workspace.json")).toBe(false);
		expect(filter(".obsidian/workspace-mobile.json")).toBe(false);
		expect(filter(".obsidian/plugins/azure-blob-sync/data.json")).toBe(false);
		expect(filter(".obsidian/plugins/azure-blob-sync/sync-state.json")).toBe(false);
		expect(filter(".obsidian/.git/x")).toBe(false);
		expect(filter("")).toBe(false);
		expect(filter("../escape.md")).toBe(false);
		expect(filter("/abs.md")).toBe(false);
	});

	it("excludes the config folder unless enabled", () => {
		const f = createPathFilter({
			configDir: ".obsidian",
			pluginDir: ".obsidian/plugins/azure-blob-sync",
			syncConfigDir: false,
			ignorePatterns: [],
		});
		expect(f(".obsidian/app.json")).toBe(false);
		expect(f("note.md")).toBe(true);
	});

	it("globToRegExp edge cases", () => {
		expect(globToRegExp("")).toBeNull();
		expect(globToRegExp("# x")).toBeNull();
		expect(globToRegExp("/")).toBeNull();
		expect(globToRegExp("a/**/b.md")!.test("a/b.md")).toBe(true);
		expect(globToRegExp("a/**/b.md")!.test("a/x/y/b.md")).toBe(true);
		expect(globToRegExp("(x).md")!.test("(x).md")).toBe(true);
	});
});

describe("utilities", () => {
	it("sha256Hex", async () => {
		expect(await sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(await sha256Hex(new ArrayBuffer(0))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("conflictCopyPath", () => {
		const d = new Date(2026, 0, 2, 3, 4, 5);
		const none = () => false;
		expect(conflictCopyPath("a/b/Note.md", d, none)).toBe("a/b/Note (conflict 2026-01-02 03-04-05).md");
		expect(conflictCopyPath("README", d, none)).toBe("README (conflict 2026-01-02 03-04-05)");
		expect(conflictCopyPath(".obsidian/.hidden", d, none)).toBe(".obsidian/.hidden (conflict 2026-01-02 03-04-05)");
		expect(conflictCopyPath("x.tar.gz", d, none)).toBe("x.tar (conflict 2026-01-02 03-04-05).gz");
		const taken = new Set(["N (conflict 2026-01-02 03-04-05).md", "N (conflict 2026-01-02 03-04-05 2).md"]);
		expect(conflictCopyPath("N.md", d, (p) => taken.has(p))).toBe("N (conflict 2026-01-02 03-04-05 3).md");
	});

	it("runWithConcurrency respects the limit", async () => {
		let running = 0;
		let peak = 0;
		const done: number[] = [];
		await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
			done.push(n);
		});
		expect(peak).toBe(3);
		expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
		await runWithConcurrency([], 3, async () => {
			throw new Error("not called");
		});
	});

	it("Mutex serializes and survives errors", async () => {
		const m = new Mutex();
		const order: string[] = [];
		const a = m.run(async () => {
			order.push("a start");
			await new Promise((r) => setTimeout(r, 10));
			order.push("a end");
		});
		const b = m.run(async () => {
			order.push("b");
			throw new Error("b failed");
		});
		const c = m.run(async () => {
			order.push("c");
			return 42;
		});
		await a;
		await expect(b).rejects.toThrow("b failed");
		expect(await c).toBe(42);
		expect(order).toEqual(["a start", "a end", "b", "c"]);
		expect(m.isLocked).toBe(false);
	});
});
