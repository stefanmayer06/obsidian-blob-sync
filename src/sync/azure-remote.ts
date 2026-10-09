import { AzureBlobClient, AzureError, contentTypeFor, isPreconditionFailure, type BlobProperties } from "../azure/client";
import type { ListedBlob } from "../azure/xml";
import { RemoteConflictError, type RemoteFileInfo, type RemoteStore, type UploadOptions } from "./types";

/** Blob metadata keys used to round-trip file information. */
export const META_MTIME = "mtime";
export const META_SHA256 = "sha256";

/** RemoteStore backed by a blob container, mapping vault paths to "<prefix><path>". */
export class AzureRemoteStore implements RemoteStore {
	constructor(private readonly client: AzureBlobClient) {}

	private blobName(path: string): string {
		return this.client.prefix + path;
	}

	async list(): Promise<RemoteFileInfo[]> {
		const prefix = this.client.prefix;
		const blobs = await this.client.listBlobs(prefix);
		const files: RemoteFileInfo[] = [];
		for (const blob of blobs) {
			if (!blob.name.startsWith(prefix)) continue;
			const path = blob.name.slice(prefix.length);
			// Skip folder placeholders (Storage Explorer / Data Lake hierarchical namespace).
			if (!path || path.endsWith("/") || blob.metadata["hdi_isfolder"] === "true") continue;
			files.push(toRemoteInfo(path, blob));
		}
		return files;
	}

	async download(path: string): Promise<{ data: ArrayBuffer; info: RemoteFileInfo }> {
		const { data, properties } = await this.client.getBlob(this.blobName(path));
		return { data, info: toRemoteInfo(path, properties) };
	}

	async upload(path: string, data: ArrayBuffer, options: UploadOptions): Promise<RemoteFileInfo> {
		try {
			const props = await this.client.putBlob(this.blobName(path), data, {
				contentType: contentTypeFor(path),
				metadata: { [META_MTIME]: String(Math.round(options.mtime)), [META_SHA256]: options.sha256 },
				ifMatch: options.ifMatch,
				ifNoneMatchAny: options.ifNoneMatchAny,
			});
			return toRemoteInfo(path, props);
		} catch (e) {
			if (isPreconditionFailure(e) || (e instanceof AzureError && e.code === "BlobNotFound")) {
				throw new RemoteConflictError(`"${path}" was changed by another device`);
			}
			throw e;
		}
	}

	async delete(path: string, options: { ifMatch?: string }): Promise<void> {
		try {
			await this.client.deleteBlob(this.blobName(path), options);
		} catch (e) {
			if (isPreconditionFailure(e)) {
				throw new RemoteConflictError(`"${path}" was changed by another device`);
			}
			throw e;
		}
	}
}

function toRemoteInfo(path: string, blob: ListedBlob | BlobProperties): RemoteFileInfo {
	const mtime = parseInt(blob.metadata[META_MTIME] ?? "", 10);
	const sha256 = blob.metadata[META_SHA256];
	return {
		path,
		etag: blob.etag,
		lastModified: blob.lastModified,
		size: blob.size,
		mtime: isNaN(mtime) ? undefined : mtime,
		sha256: sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : undefined,
	};
}
