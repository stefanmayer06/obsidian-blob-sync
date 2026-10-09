import {
	BlobServiceClient,
	ContainerSASPermissions,
	SASProtocol,
	StorageSharedKeyCredential,
	generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient } from "../../src/azure/client";

/** Well-known Azurite development account. */
export const ACCOUNT = "devstoreaccount1";
export const ACCOUNT_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export interface Azurite {
	serviceUrl: string;
	service: BlobServiceClient;
	stop(): Promise<void>;
	/** Creates a container and returns a SAS token for it. */
	createContainer(name: string, permissions?: string): Promise<string>;
	sasFor(container: string, permissions: string, expiresInMs?: number): string;
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = createConnection({ port, host: "127.0.0.1" }, () => {
				socket.end();
				resolve();
			});
			socket.on("error", () => {
				socket.destroy();
				if (Date.now() - started > timeoutMs) reject(new Error(`Azurite did not start on port ${port}`));
				else setTimeout(attempt, 100);
			});
		};
		attempt();
	});
}

export async function startAzurite(port = 20000 + Math.floor(Math.random() * 20000)): Promise<Azurite> {
	const location = mkdtempSync(join(tmpdir(), "azurite-"));
	const bin = join(process.cwd(), "node_modules", ".bin", "azurite-blob");
	const child: ChildProcess = spawn(
		bin,
		[
			"--blobHost",
			"127.0.0.1",
			"--blobPort",
			String(port),
			"--location",
			location,
			"--silent",
			"--skipApiVersionCheck",
		],
		{ stdio: "ignore" },
	);
	await waitForPort(port, 20_000);

	const serviceUrl = `http://127.0.0.1:${port}/${ACCOUNT}`;
	const credential = new StorageSharedKeyCredential(ACCOUNT, ACCOUNT_KEY);
	const service = new BlobServiceClient(serviceUrl, credential);

	const sasFor = (container: string, permissions: string, expiresInMs = 3_600_000) =>
		generateBlobSASQueryParameters(
			{
				containerName: container,
				permissions: ContainerSASPermissions.parse(permissions),
				startsOn: new Date(Date.now() - 60_000),
				expiresOn: new Date(Date.now() + expiresInMs),
				protocol: SASProtocol.HttpsAndHttp,
			},
			credential,
		).toString();

	return {
		serviceUrl,
		service,
		sasFor,
		async createContainer(name: string, permissions = "racwdl") {
			await service.getContainerClient(name).createIfNotExists();
			return sasFor(name, permissions);
		},
		async stop() {
			child.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 200));
			rmSync(location, { recursive: true, force: true });
		},
	};
}

/** HttpClient for Node (the plugin uses Obsidian's requestUrl instead). */
export const fetchHttp: HttpClient = async (req) => {
	const res = await fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body !== undefined ? new Uint8Array(req.body) : undefined,
	});
	const buffer = await res.arrayBuffer();
	const headers: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return {
		status: res.status,
		headers,
		arrayBuffer: buffer,
		get text() {
			return new TextDecoder().decode(buffer);
		},
	};
};
