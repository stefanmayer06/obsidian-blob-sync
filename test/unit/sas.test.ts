import { describe, expect, it } from "vitest";
import {
	connectionFingerprint,
	normalizePrefix,
	normalizeSasToken,
	parseSasToken,
	parseSasUrl,
	resolveConnection,
	validateSasToken,
} from "../../src/azure/sas";

const NOW = new Date("2026-06-01T00:00:00Z");
const GOOD_SERVICE_SAS = "sv=2022-11-02&sr=c&sp=racwdl&st=2026-01-01T00:00:00Z&se=2027-01-01T00:00:00Z&spr=https&sig=abc%2Bdef%3D";
const GOOD_ACCOUNT_SAS = "sv=2022-11-02&ss=b&srt=sco&sp=rwdlacupiytfx&se=2027-01-01T00:00:00Z&st=2026-01-01T00:00:00Z&spr=https&sig=xyz";

describe("SAS token parsing and validation", () => {
	it("normalizes leading ? and whitespace", () => {
		expect(normalizeSasToken("  ?sv=1&sig=2 ")).toBe("sv=1&sig=2");
	});

	it("parses service SAS fields", () => {
		const info = parseSasToken(GOOD_SERVICE_SAS);
		expect(info.permissions).toBe("racwdl");
		expect(info.resource).toBe("c");
		expect(info.expiry?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
		expect(info.hasSignature).toBe(true);
		expect(info.isAccountSas).toBe(false);
	});

	it("accepts good service and account SAS tokens", () => {
		expect(validateSasToken(GOOD_SERVICE_SAS, NOW)).toEqual([]);
		expect(validateSasToken("?" + GOOD_ACCOUNT_SAS, NOW)).toEqual([]);
	});

	it("reports expired, not-yet-valid, missing signature and missing permissions", () => {
		const expired = validateSasToken(GOOD_SERVICE_SAS, new Date("2028-01-01Z"));
		expect(expired.join()).toMatch(/expired/);
		const early = validateSasToken(GOOD_SERVICE_SAS, new Date("2025-01-01Z"));
		expect(early.join()).toMatch(/not valid until/);
		expect(validateSasToken("sv=2022-11-02&sp=rwdl", NOW).join()).toMatch(/no signature/);
		const readOnly = validateSasToken("sv=2022-11-02&sr=c&sp=rl&sig=x", NOW).join();
		expect(readOnly).toMatch(/write \(w\)/);
		expect(readOnly).toMatch(/delete \(d\)/);
		expect(validateSasToken("", NOW)).toEqual(["SAS token is empty."]);
	});

	it("reports wrong scopes", () => {
		expect(validateSasToken("sv=1&sr=b&sp=rwdl&sig=x", NOW).join()).toMatch(/not scoped to a container/);
		expect(validateSasToken("sv=1&ss=q&srt=sco&sp=rwdl&sig=x", NOW).join()).toMatch(/Blob service/);
		expect(validateSasToken("sv=1&ss=b&srt=s&sp=rwdl&sig=x", NOW).join()).toMatch(/resource types/);
	});
});

describe("SAS URL parsing", () => {
	it("parses a container SAS URL from the portal", () => {
		const r = parseSasUrl(`https://mystorage.blob.core.windows.net/obsidian?${GOOD_SERVICE_SAS}`);
		expect(r).toEqual({
			accountName: "mystorage",
			containerName: "obsidian",
			serviceUrl: "",
			remotePrefix: "",
			sasToken: GOOD_SERVICE_SAS,
		});
	});

	it("parses an account SAS URL without container", () => {
		const r = parseSasUrl(`https://mystorage.blob.core.windows.net/?${GOOD_ACCOUNT_SAS}`);
		expect(r.accountName).toBe("mystorage");
		expect(r.containerName).toBeUndefined();
		expect(r.sasToken).toBe(GOOD_ACCOUNT_SAS);
	});

	it("parses a folder path into the remote prefix", () => {
		const r = parseSasUrl(`https://acct.blob.core.windows.net/vaults/my%20notes/personal?sig=x`);
		expect(r.containerName).toBe("vaults");
		expect(r.remotePrefix).toBe("my notes/personal");
	});

	it("keeps sovereign cloud endpoints", () => {
		const r = parseSasUrl("https://acct.blob.core.chinacloudapi.cn/c1?sig=x");
		expect(r.accountName).toBe("acct");
		expect(r.serviceUrl).toBe("https://acct.blob.core.chinacloudapi.cn");
	});

	it("parses Azurite path-style URLs", () => {
		const r = parseSasUrl("http://127.0.0.1:10000/devstoreaccount1/vault?sv=x&sig=y");
		expect(r).toEqual({
			accountName: "devstoreaccount1",
			serviceUrl: "http://127.0.0.1:10000/devstoreaccount1",
			containerName: "vault",
			remotePrefix: "",
			sasToken: "sv=x&sig=y",
		});
	});

	it("parses custom domains", () => {
		const r = parseSasUrl("https://files.example.com/notes?sig=y");
		expect(r.serviceUrl).toBe("https://files.example.com");
		expect(r.containerName).toBe("notes");
	});

	it("rejects garbage", () => {
		expect(() => parseSasUrl("not a url")).toThrow(/URL/);
		expect(() => parseSasUrl("ftp://x/y")).toThrow(/https/);
	});
});

describe("resolveConnection", () => {
	const base = { accountName: "acct", containerName: "vault", sasToken: "?sv=1&sig=2", serviceUrl: "", remotePrefix: "" };

	it("builds the default endpoint", () => {
		const c = resolveConnection(base);
		expect(c).toEqual({
			serviceUrl: "https://acct.blob.core.windows.net",
			containerName: "vault",
			sasToken: "sv=1&sig=2",
			prefix: "",
		});
		expect(connectionFingerprint(c)).toBe("https://acct.blob.core.windows.net/vault/");
	});

	it("uses the override URL and normalizes the prefix", () => {
		const c = resolveConnection({
			...base,
			serviceUrl: "http://127.0.0.1:10000/devstoreaccount1/",
			remotePrefix: "/a//b/ ",
		});
		expect(c.serviceUrl).toBe("http://127.0.0.1:10000/devstoreaccount1");
		expect(c.prefix).toBe("a/b/");
	});

	it("validates required values", () => {
		expect(() => resolveConnection({ ...base, accountName: "" })).toThrow(/account name/);
		expect(() => resolveConnection({ ...base, accountName: "Bad_Name" })).toThrow(/3-24/);
		expect(() => resolveConnection({ ...base, containerName: "" })).toThrow(/Container name is not set/);
		expect(() => resolveConnection({ ...base, containerName: "Bad--Name" })).toThrow(/Container name/);
		expect(() => resolveConnection({ ...base, sasToken: " " })).toThrow(/SAS token/);
		expect(() => resolveConnection({ ...base, serviceUrl: "nope" })).toThrow(/service URL/);
		expect(() => resolveConnection({ ...base, serviceUrl: "https://x.com/?sig=1" })).toThrow(/service URL/);
	});

	it("normalizePrefix", () => {
		expect(normalizePrefix("")).toBe("");
		expect(normalizePrefix("/")).toBe("");
		expect(normalizePrefix("a\\b")).toBe("a/b/");
		expect(normalizePrefix("./x/")).toBe("x/");
	});
});
