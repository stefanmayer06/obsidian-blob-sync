import { requestUrl } from "obsidian";
import type { HttpClient, HttpRequest, HttpResponse } from "../azure/client";

/**
 * HttpClient backed by Obsidian's requestUrl. Requests are made outside the
 * browser sandbox, so the storage account needs no CORS rules — on desktop
 * and on mobile.
 */
export const obsidianHttp: HttpClient = async (req: HttpRequest): Promise<HttpResponse> => {
	const headers: Record<string, string> = {};
	let contentType: string | undefined;
	for (const [key, value] of Object.entries(req.headers)) {
		if (key.toLowerCase() === "content-type") contentType = value;
		else headers[key] = value;
	}
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers,
		contentType,
		body: req.body,
		throw: false,
	});
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(res.headers ?? {})) lower[key.toLowerCase()] = String(value);

	let text: string | undefined;
	let buffer: ArrayBuffer | undefined;
	return {
		status: res.status,
		headers: lower,
		get arrayBuffer(): ArrayBuffer {
			if (buffer === undefined) buffer = res.arrayBuffer ?? new ArrayBuffer(0);
			return buffer;
		},
		get text(): string {
			if (text === undefined) {
				try {
					text = res.text ?? "";
				} catch {
					text = "";
				}
			}
			return text;
		},
	};
};
