import type { ResolvedConnection } from "./sas";
import { normalizeEtag, parseErrorXml, parseListBlobsXml, type ListedBlob } from "./xml";

/** Azure Storage REST API version used for all requests. */
export const AZURE_API_VERSION = "2021-12-02";

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	/** Header names must be lower case. */
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

/**
 * Transport abstraction. Inside Obsidian this is backed by `requestUrl`
 * (no CORS configuration needed on the storage account); tests use fetch.
 * Implementations must not throw on HTTP error statuses.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export class AzureError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = "AzureError";
	}
}

/** True when a conditional write/delete lost a race against another writer. */
export function isPreconditionFailure(err: unknown): boolean {
	if (!(err instanceof AzureError)) return false;
	return (
		err.status === 412 ||
		(err.status === 409 && (err.code === "BlobAlreadyExists" || err.code === "ConditionNotMet"))
	);
}

export interface BlobProperties {
	etag: string;
	lastModified: number;
	size: number;
	metadata: Record<string, string>;
}

export interface PutBlobOptions {
	contentType?: string;
	metadata?: Record<string, string>;
	/** Only overwrite when the current blob has this ETag. */
	ifMatch?: string;
	/** Only create the blob if it doesn't exist yet. */
	ifNoneMatchAny?: boolean;
}

export interface AzureBlobClientOptions {
	retries?: number;
	retryDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Larger uploads are sent in blocks, larger downloads in ranges of this size. */
	chunkSize?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * On mobile, requestUrl hands request and response bodies to the native side
 * as base64, which fails ("Invalid array length") or runs out of memory for
 * files of a few tens of MB. Transfers are split so no request carries more.
 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export class AzureBlobClient {
	private readonly retries: number;
	private readonly retryDelayMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly chunkSize: number;

	constructor(
		private readonly conn: ResolvedConnection,
		private readonly http: HttpClient,
		options: AzureBlobClientOptions = {},
	) {
		this.retries = options.retries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 500;
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => window.setTimeout(r, ms)));
		this.chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
	}

	get prefix(): string {
		return this.conn.prefix;
	}

	private containerUrl(query: Record<string, string>): string {
		const params = new URLSearchParams(query).toString();
		const sep = params ? "&" : "";
		return `${this.conn.serviceUrl}/${encodeURIComponent(this.conn.containerName)}?${params}${sep}${this.conn.sasToken}`;
	}

	blobUrl(blobName: string, query: Record<string, string> = {}): string {
		const encoded = blobName
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		const params = new URLSearchParams(query).toString();
		const sep = params ? "&" : "";
		return `${this.conn.serviceUrl}/${encodeURIComponent(this.conn.containerName)}/${encoded}?${params}${sep}${this.conn.sasToken}`;
	}

	private async send(request: HttpRequest, context: string): Promise<HttpResponse> {
		request.headers = { "x-ms-version": AZURE_API_VERSION, ...request.headers };
		let attempt = 0;
		for (;;) {
			let response: HttpResponse | undefined;
			let networkError: unknown;
			try {
				response = await this.http(request);
			} catch (e) {
				networkError = e;
			}
			const retryable = networkError !== undefined || (response && RETRYABLE_STATUS.has(response.status));
			if (retryable && attempt < this.retries) {
				await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
				attempt++;
				continue;
			}
			if (networkError !== undefined) {
				const msg =
					networkError instanceof Error
						? networkError.message
						: typeof networkError === "string"
							? networkError
							: "unknown error";
				throw new AzureError(`${context}: network error (${msg})`, 0, "NetworkError");
			}
			return response!;
		}
	}

	private toError(response: HttpResponse, context: string): AzureError {
		let code = response.headers["x-ms-error-code"];
		let message: string | undefined;
		try {
			const parsed = parseErrorXml(response.text);
			code = code ?? parsed.code;
			message = parsed.message;
		} catch {
			// ignore unparsable bodies
		}
		return new AzureError(
			`${context}: ${describeError(response.status, code, message)}`,
			response.status,
			code,
		);
	}

	/** Lists all blobs below the given name prefix (handles pagination). */
	async listBlobs(namePrefix: string, maxResults = 5000): Promise<ListedBlob[]> {
		const all: ListedBlob[] = [];
		let marker = "";
		do {
			const query: Record<string, string> = {
				restype: "container",
				comp: "list",
				include: "metadata",
				maxresults: String(maxResults),
			};
			if (namePrefix) query.prefix = namePrefix;
			if (marker) query.marker = marker;
			const response = await this.send(
				{ url: this.containerUrl(query), method: "GET", headers: { "Cache-Control": "no-cache" } },
				"List blobs",
			);
			if (response.status !== 200) throw this.toError(response, "List blobs");
			const page = parseListBlobsXml(response.text);
			all.push(...page.blobs);
			marker = page.nextMarker;
		} while (marker);
		return all;
	}

	/** Lists at most one blob; used to verify connectivity and list/read permission. */
	async probe(namePrefix: string): Promise<void> {
		const query: Record<string, string> = {
			restype: "container",
			comp: "list",
			maxresults: "1",
		};
		if (namePrefix) query.prefix = namePrefix;
		const response = await this.send(
			{ url: this.containerUrl(query), method: "GET", headers: { "Cache-Control": "no-cache" } },
			"Connect",
		);
		if (response.status !== 200) throw this.toError(response, "Connect");
	}

	/** Downloads a blob; blobs larger than the chunk size are fetched in ranges. */
	async getBlob(blobName: string): Promise<{ data: ArrayBuffer; properties: BlobProperties }> {
		const context = `Download "${blobName}"`;
		const url = this.blobUrl(blobName);
		const get = (headers: Record<string, string>) =>
			this.send({ url, method: "GET", headers: { "Cache-Control": "no-cache", ...headers } }, context);

		let response = await get({ "x-ms-range": `bytes=0-${this.chunkSize - 1}` });
		// An empty blob has no byte 0, so the range can't be satisfied.
		if (response.status === 416) response = await get({});
		if (response.status === 200) return { data: response.arrayBuffer, properties: propertiesFromHeaders(response) };
		if (response.status !== 206) throw this.toError(response, context);

		const properties = propertiesFromHeaders(response);
		const total = parseInt(/\/(\d+)$/.exec(response.headers["content-range"] ?? "")?.[1] ?? "", 10);
		if (isNaN(total)) throw new AzureError(`${context}: the response has no valid Content-Range`, response.status);
		properties.size = total;
		const first = response.arrayBuffer;
		if (first.byteLength >= total) return { data: first, properties };

		const data = new Uint8Array(total);
		data.set(new Uint8Array(first), 0);
		let offset = first.byteLength;
		while (offset < total) {
			const end = Math.min(offset + this.chunkSize, total) - 1;
			// If-Match: a blob replaced mid-download fails with 412 instead of mixing two versions.
			response = await get({ "x-ms-range": `bytes=${offset}-${end}`, "If-Match": `"${properties.etag}"` });
			if (response.status !== 206) throw this.toError(response, context);
			const chunk = new Uint8Array(response.arrayBuffer);
			if (chunk.byteLength === 0 || offset + chunk.byteLength > total) {
				throw new AzureError(`${context}: unexpected response size`, response.status);
			}
			data.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { data: data.buffer, properties };
	}

	/** Uploads a blob; data larger than the chunk size is staged in blocks and then committed. */
	async putBlob(blobName: string, data: ArrayBuffer, options: PutBlobOptions = {}): Promise<BlobProperties> {
		const contentType = options.contentType ?? "application/octet-stream";
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.metadata ?? {})) {
			headers[`x-ms-meta-${key}`] = value;
		}
		if (options.ifMatch) headers["If-Match"] = `"${normalizeEtag(options.ifMatch)}"`;
		if (options.ifNoneMatchAny) headers["If-None-Match"] = "*";
		const context = `Upload "${blobName}"`;
		const response =
			data.byteLength <= this.chunkSize
				? await this.send(
						{
							url: this.blobUrl(blobName),
							method: "PUT",
							headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": contentType, ...headers },
							body: data,
						},
						context,
					)
				: await this.putBlocks(blobName, data, { "x-ms-blob-content-type": contentType, ...headers }, context);
		if (response.status !== 201) throw this.toError(response, context);
		const props = propertiesFromHeaders(response);
		props.size = data.byteLength;
		props.metadata = { ...(options.metadata ?? {}) };
		return props;
	}

	/**
	 * Put Block for each chunk, then Put Block List with the given headers.
	 * Blocks stay invisible until committed, and the commit is the only
	 * request that carries the If-Match / If-None-Match conditions.
	 */
	private async putBlocks(
		blobName: string,
		data: ArrayBuffer,
		commitHeaders: Record<string, string>,
		context: string,
	): Promise<HttpResponse> {
		// Unique per upload, so devices uploading the same path never commit each other's blocks.
		// All IDs have the same length, as Azure requires.
		const uploadId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const blockIds: string[] = [];
		for (let offset = 0; offset < data.byteLength; offset += this.chunkSize) {
			const blockId = btoa(`${uploadId}-${String(blockIds.length).padStart(6, "0")}`);
			blockIds.push(blockId);
			const response = await this.send(
				{
					url: this.blobUrl(blobName, { comp: "block", blockid: blockId }),
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: data.slice(offset, offset + this.chunkSize),
				},
				context,
			);
			if (response.status !== 201) throw this.toError(response, context);
		}
		const xml =
			`<?xml version="1.0" encoding="utf-8"?><BlockList>` +
			blockIds.map((id) => `<Latest>${id}</Latest>`).join("") +
			`</BlockList>`;
		const body = new TextEncoder().encode(xml);
		return this.send(
			{
				url: this.blobUrl(blobName, { comp: "blocklist" }),
				method: "PUT",
				headers: { "Content-Type": "application/xml; charset=utf-8", ...commitHeaders },
				body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
			},
			context,
		);
	}

	/** Deletes a blob. Returns false when it didn't exist. */
	async deleteBlob(blobName: string, options: { ifMatch?: string } = {}): Promise<boolean> {
		const headers: Record<string, string> = {};
		if (options.ifMatch) headers["If-Match"] = `"${normalizeEtag(options.ifMatch)}"`;
		const context = `Delete "${blobName}"`;
		const response = await this.send({ url: this.blobUrl(blobName), method: "DELETE", headers }, context);
		if (response.status === 202) return true;
		if (response.status === 404) return false;
		throw this.toError(response, context);
	}
}

function propertiesFromHeaders(response: HttpResponse): BlobProperties {
	const h = response.headers;
	const metadata: Record<string, string> = {};
	for (const [key, value] of Object.entries(h)) {
		if (key.startsWith("x-ms-meta-")) metadata[key.slice("x-ms-meta-".length)] = value;
	}
	const lastModified = h["last-modified"] ? Date.parse(h["last-modified"]) : 0;
	return {
		etag: normalizeEtag(h["etag"]),
		lastModified: isNaN(lastModified) ? 0 : lastModified,
		size: parseInt(h["content-length"] ?? "0", 10) || 0,
		metadata,
	};
}

function describeError(status: number, code?: string, message?: string): string {
	switch (code) {
		case "AuthenticationFailed":
			return "authentication failed. The SAS token is invalid, expired, or was copied incompletely.";
		case "AuthorizationPermissionMismatch":
		case "AuthorizationResourceTypeMismatch":
		case "AuthorizationServiceMismatch":
			return "the SAS token doesn't allow this operation. It needs read, write, delete and list permissions on the container.";
		case "AuthorizationFailure":
			return "access denied. Check the SAS token and the storage account's network/firewall settings.";
		case "ContainerNotFound":
			return "the container doesn't exist. Create it in the Azure portal first or fix the container name.";
		case "ResourceNotFound":
			return "not found. Check the storage account name, container name and service URL.";
		case "InvalidQueryParameterValue":
			return `invalid request (${message ?? code}). Check the SAS token.`;
	}
	const detail = [code, message].filter(Boolean).join(": ");
	return `HTTP ${status}${detail ? ` (${detail})` : ""}`;
}

const CONTENT_TYPES: Record<string, string> = {
	md: "text/markdown; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	json: "application/json",
	canvas: "application/json",
	css: "text/css",
	js: "text/javascript",
	html: "text/html",
	csv: "text/csv",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
};

export function contentTypeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
