/**
 * Minimal, dependency free parser for the Azure "List Blobs" XML response.
 * Avoids DOMParser so it runs identically inside Obsidian (desktop + mobile)
 * and in Node based tests.
 */

export interface ListedBlob {
	name: string;
	etag: string;
	lastModified: number;
	size: number;
	contentMd5?: string;
	metadata: Record<string, string>;
}

export interface ListBlobsPage {
	blobs: ListedBlob[];
	nextMarker: string;
}

export function decodeXmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default:
				if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
				return String.fromCodePoint(parseInt(entity.slice(1), 10));
		}
	});
}

/** Removes surrounding quotes so ETags from headers and XML compare equal. */
export function normalizeEtag(etag: string | undefined | null): string {
	if (!etag) return "";
	let e = etag.trim();
	if (e.startsWith("W/")) e = e.slice(2);
	if (e.startsWith('"') && e.endsWith('"') && e.length >= 2) e = e.slice(1, -1);
	return e;
}

function tagContent(xml: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`);
	const m = re.exec(xml);
	if (!m) return undefined;
	return m[1] ?? "";
}

export function parseListBlobsXml(xml: string): ListBlobsPage {
	const blobs: ListedBlob[] = [];
	const blobRe = /<Blob>([\s\S]*?)<\/Blob>/g;
	let match: RegExpExecArray | null;
	while ((match = blobRe.exec(xml)) !== null) {
		let body = match[1];

		let metadata: Record<string, string> = {};
		const metaMatch = /<Metadata\s*\/>|<Metadata>([\s\S]*?)<\/Metadata>/.exec(body);
		if (metaMatch) {
			metadata = parseMetadata(metaMatch[1] ?? "");
			body = body.slice(0, metaMatch.index) + body.slice(metaMatch.index + metaMatch[0].length);
		}
		const propsMatch = /<Properties>([\s\S]*?)<\/Properties>/.exec(body);
		const props = propsMatch ? propsMatch[1] : "";
		if (propsMatch) {
			body = body.slice(0, propsMatch.index) + body.slice(propsMatch.index + propsMatch[0].length);
		}

		const nameMatch = /<Name(\s[^>]*)?>([\s\S]*?)<\/Name>/.exec(body);
		if (!nameMatch) continue;
		let name = decodeXmlEntities(nameMatch[2]);
		if (nameMatch[1] && /Encoded\s*=\s*"true"/i.test(nameMatch[1])) {
			name = decodeURIComponent(name);
		}

		const lastModifiedRaw = tagContent(props, "Last-Modified");
		const lastModified = lastModifiedRaw ? Date.parse(decodeXmlEntities(lastModifiedRaw)) : 0;
		const size = parseInt(tagContent(props, "Content-Length") ?? "0", 10);
		const md5 = tagContent(props, "Content-MD5");

		blobs.push({
			name,
			etag: normalizeEtag(decodeXmlEntities(tagContent(props, "Etag") ?? "")),
			lastModified: isNaN(lastModified) ? 0 : lastModified,
			size: isNaN(size) ? 0 : size,
			contentMd5: md5 ? decodeXmlEntities(md5) : undefined,
			metadata,
		});
	}
	const nextMarker = decodeXmlEntities(tagContent(xml, "NextMarker") ?? "").trim();
	return { blobs, nextMarker };
}

function parseMetadata(xml: string): Record<string, string> {
	const result: Record<string, string> = {};
	const re = /<([A-Za-z_][\w.-]*)(?:\s*\/>|>([\s\S]*?)<\/\1>)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		result[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? "");
	}
	return result;
}

/** Extracts Code / Message from an Azure error response body. */
export function parseErrorXml(xml: string): { code?: string; message?: string } {
	const code = tagContent(xml, "Code");
	const message = tagContent(xml, "Message");
	return {
		code: code ? decodeXmlEntities(code).trim() : undefined,
		message: message ? decodeXmlEntities(message).trim().split("\n")[0] : undefined,
	};
}
