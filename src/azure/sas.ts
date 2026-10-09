/**
 * Helpers for turning user input (a full SAS URL, or the individual values)
 * into a validated connection description for the Azure Blob client.
 */

export interface ConnectionSettings {
	/** Storage account name, e.g. "mystorageaccount". */
	accountName: string;
	/** Blob container name, e.g. "obsidian". */
	containerName: string;
	/** SAS token (query string), with or without the leading "?". */
	sasToken: string;
	/**
	 * Optional blob service URL override. Leave empty to use
	 * https://<account>.blob.core.windows.net. Useful for sovereign clouds,
	 * private endpoints, custom domains or the Azurite emulator
	 * (e.g. http://127.0.0.1:10000/devstoreaccount1).
	 */
	serviceUrl: string;
	/** Optional folder inside the container that holds the vault, e.g. "vaults/personal". */
	remotePrefix: string;
}

export interface ResolvedConnection {
	/** Blob service base URL without trailing slash. */
	serviceUrl: string;
	containerName: string;
	/** SAS query string without the leading "?". */
	sasToken: string;
	/** Normalized prefix: "" or "some/folder/". */
	prefix: string;
}

export interface SasInfo {
	version?: string;
	permissions?: string;
	start?: Date;
	expiry?: Date;
	/** Service SAS resource ("c" = container, "b" = blob, ...). */
	resource?: string;
	/** Account SAS services ("b" = blob, ...). */
	services?: string;
	/** Account SAS resource types ("s" service, "c" container, "o" object). */
	resourceTypes?: string;
	hasSignature: boolean;
	/** True when the token is a user-delegation SAS or similar we can't fully inspect. */
	isAccountSas: boolean;
}

export const REQUIRED_PERMISSIONS = ["r", "w", "d", "l"] as const;

const PERMISSION_NAMES: Record<string, string> = {
	r: "read",
	w: "write",
	d: "delete",
	l: "list",
};

/** Strip whitespace and a leading "?" from a SAS token. */
export function normalizeSasToken(token: string): string {
	let t = token.trim();
	if (t.startsWith("?")) t = t.slice(1);
	return t;
}

/** Normalize a remote folder prefix to "" or "a/b/". */
export function normalizePrefix(prefix: string): string {
	const parts = prefix
		.replace(/\\/g, "/")
		.split("/")
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== ".");
	return parts.length ? parts.join("/") + "/" : "";
}

export function parseSasToken(token: string): SasInfo {
	const params = new URLSearchParams(normalizeSasToken(token));
	const parseDate = (v: string | null): Date | undefined => {
		if (!v) return undefined;
		const d = new Date(v);
		return isNaN(d.getTime()) ? undefined : d;
	};
	const services = params.get("ss") ?? undefined;
	return {
		version: params.get("sv") ?? undefined,
		permissions: params.get("sp") ?? undefined,
		start: parseDate(params.get("st")),
		expiry: parseDate(params.get("se")),
		resource: params.get("sr") ?? undefined,
		services,
		resourceTypes: params.get("srt") ?? undefined,
		hasSignature: params.has("sig"),
		isAccountSas: services !== undefined,
	};
}

/**
 * Returns human readable problems with a SAS token. An empty list means the
 * token looks usable (Azure is still the final judge).
 */
export function validateSasToken(token: string, now: Date = new Date()): string[] {
	const problems: string[] = [];
	const normalized = normalizeSasToken(token);
	if (!normalized) {
		return ["SAS token is empty."];
	}
	const info = parseSasToken(normalized);
	if (!info.hasSignature) {
		problems.push('SAS token has no signature ("sig=" is missing). Copy the complete token.');
	}
	if (info.expiry && info.expiry.getTime() <= now.getTime()) {
		problems.push(`SAS token expired on ${info.expiry.toISOString()}.`);
	}
	if (info.start && info.start.getTime() > now.getTime()) {
		problems.push(`SAS token is not valid until ${info.start.toISOString()}.`);
	}
	if (info.permissions !== undefined) {
		const missing = REQUIRED_PERMISSIONS.filter((p) => !info.permissions!.includes(p));
		if (missing.length) {
			problems.push(
				`SAS token is missing permission(s): ${missing
					.map((p) => `${PERMISSION_NAMES[p]} (${p})`)
					.join(", ")}. Read, write, delete and list are required.`,
			);
		}
	}
	if (info.isAccountSas) {
		if (info.services && !info.services.includes("b")) {
			problems.push('Account SAS does not include the Blob service (ss must contain "b").');
		}
		if (info.resourceTypes) {
			const rt = info.resourceTypes;
			if (!rt.includes("c") || !rt.includes("o")) {
				problems.push(
					'Account SAS needs the "Container" and "Object" resource types (srt must contain "c" and "o").',
				);
			}
		}
	} else if (info.resource && info.resource !== "c") {
		problems.push(
			'SAS token is not scoped to a container (sr should be "c"). Create the SAS on the container, not a single blob.',
		);
	}
	return problems;
}

/**
 * Parses a SAS URL as shown in the Azure portal / Storage Explorer, e.g.
 *   https://acct.blob.core.windows.net/container?sv=...&sig=...
 *   https://acct.blob.core.windows.net/?sv=...        (account SAS, no container)
 *   https://acct.blob.core.windows.net/container/notes/vault?sv=... (with folder)
 *   http://127.0.0.1:10000/devstoreaccount1/container?sv=...       (Azurite)
 * Returns the values that could be determined; missing values are omitted.
 */
export function parseSasUrl(input: string): Partial<ConnectionSettings> {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("This doesn't look like a URL. Paste the full Blob SAS URL (starting with https://).");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("The SAS URL must start with https:// (or http:// for a local emulator).");
	}
	const result: Partial<ConnectionSettings> = {};
	const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
	if (query) result.sasToken = query;

	const segments = url.pathname
		.split("/")
		.filter((s) => s.length > 0)
		.map((s) => decodeURIComponent(s));
	const standard = /^([a-z0-9]{3,24})\.blob\.(.+)$/i.exec(url.hostname);

	if (standard && !url.port) {
		result.accountName = standard[1].toLowerCase();
		const suffix = standard[2].toLowerCase();
		result.serviceUrl = suffix === "core.windows.net" ? "" : `${url.protocol}//${url.host}`;
		if (segments.length >= 1) result.containerName = segments[0];
		result.remotePrefix = segments.length > 1 ? segments.slice(1).join("/") : "";
	} else {
		// Path-style (emulator / IP based) or custom domain:
		//   http://127.0.0.1:10000/<account>/<container>
		//   https://files.example.com/<container>
		const isPathStyle =
			url.hostname === "localhost" ||
			/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
			url.hostname.startsWith("[");
		if (isPathStyle) {
			if (segments.length >= 1) result.accountName = segments[0];
			result.serviceUrl = `${url.protocol}//${url.host}${segments.length ? "/" + encodeURIComponent(segments[0]) : ""}`;
			if (segments.length >= 2) result.containerName = segments[1];
			result.remotePrefix = segments.length > 2 ? segments.slice(2).join("/") : "";
		} else {
			result.serviceUrl = `${url.protocol}//${url.host}`;
			const acct = /^([a-z0-9]{3,24})\./i.exec(url.hostname);
			if (acct) result.accountName = acct[1].toLowerCase();
			if (segments.length >= 1) result.containerName = segments[0];
			result.remotePrefix = segments.length > 1 ? segments.slice(1).join("/") : "";
		}
	}
	return result;
}

/**
 * Validates the connection settings and produces the values the client needs.
 * Throws an Error with a user friendly message when something is missing.
 */
export function resolveConnection(settings: ConnectionSettings): ResolvedConnection {
	const sasToken = normalizeSasToken(settings.sasToken);
	const containerName = settings.containerName.trim();
	let serviceUrl = settings.serviceUrl.trim().replace(/\/+$/, "");
	const accountName = settings.accountName.trim().toLowerCase();

	if (!serviceUrl) {
		if (!accountName) throw new Error("Storage account name is not set.");
		if (!/^[a-z0-9]{3,24}$/.test(accountName)) {
			throw new Error("Storage account name must be 3-24 lowercase letters or digits.");
		}
		serviceUrl = `https://${accountName}.blob.core.windows.net`;
	} else {
		try {
			const u = new URL(serviceUrl);
			if (u.search) throw new Error("x");
		} catch {
			throw new Error("Blob service URL is not a valid URL (it must not include the SAS token).");
		}
	}
	if (!containerName) throw new Error("Container name is not set.");
	if (!/^(\$root|\$web|[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9])$/.test(containerName)) {
		throw new Error(
			"Container name must be 3-63 characters of lowercase letters, digits and single hyphens.",
		);
	}
	if (!sasToken) throw new Error("SAS token is not set.");

	return {
		serviceUrl,
		containerName,
		sasToken,
		prefix: normalizePrefix(settings.remotePrefix),
	};
}

/** Stable identifier of the sync target; when it changes the sync state is reset. */
export function connectionFingerprint(conn: ResolvedConnection): string {
	return `${conn.serviceUrl}/${conn.containerName}/${conn.prefix}`;
}
