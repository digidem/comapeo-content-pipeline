/**
 * Asset rehosting: extract, download, and hash image URLs from Notion.
 *
 * Runtime-agnostic — uses Web Crypto API (available in Workers and Node 19+).
 */

export interface ExtractedAsset {
	url: string;
	/** True if this asset needs rehosting (Notion CDN URL or data: URI) */
	isNotion: boolean;
}

/** Notion CDN hosts that serve temporary image URLs. */
const NOTION_HOSTS = [
	"amazonaws.com",
	"notion.so",
	"secure.notion-static.com",
	"prod-files-secure.s3.us-west-2.amazonaws.com",
];

/** MIME type → file extension mapping. */
const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

/**
 * Extract all image URLs from markdown, tagging each as Notion-hosted or not.
 *
 * Handles three patterns:
 * 1. Hyperlinked images: `[![alt](img-url)](link-url)` — extracts `img-url`
 * 2. Plain markdown images: `![alt](url)`
 * 3. HTML img tags: `<img src="url">` and `<img src='url'>`
 */
export function extractAssetUrls(markdown: string): ExtractedAsset[] {
	const results: ExtractedAsset[] = [];
	const seen = new Set<string>();

	const addUrl = (url: string) => {
		if (seen.has(url)) return;
		seen.add(url);
		const needsRehosting = isNotionUrl(url) || url.startsWith("data:");
		results.push({ url, isNotion: needsRehosting });
	};

	// 1. Hyperlinked images: [![alt](img-url)](link-url)
	const hyperlinkedPattern = /\[!\[[^\]]*\]\(([^)]+)\)\]\([^)]+\)/g;
	let match: RegExpExecArray | null;
	while ((match = hyperlinkedPattern.exec(markdown)) !== null) {
		addUrl(match[1]);
	}

	// 2. Plain markdown images: ![alt](url)
	const mdPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
	while ((match = mdPattern.exec(markdown)) !== null) {
		addUrl(match[2]);
	}

	// 3. HTML img tags: <img src="url"> or <img src='url'>
	const htmlPattern = /<img\s[^>]*src=(["'])([^"']+)\1[^>]*>/gi;
	while ((match = htmlPattern.exec(markdown)) !== null) {
		addUrl(match[2]);
	}

	return results;
}

/**
 * Sleep for `ms` milliseconds (runtime-agnostic).
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download an asset and return its binary data, content type, and extension.
 *
 * Retries up to 3 times with exponential backoff (1 s, 2 s, 4 s) on network
 * errors. HTTP 4xx responses are NOT retried. Returns `null` if all retries
 * are exhausted.
 */
export const MAX_DATA_URI_BYTES = 10 * 1024 * 1024; // 10 MB limit for embedded data URIs
const MAX_DATA_URI_ENCODED_CHARS = Math.ceil((MAX_DATA_URI_BYTES * 4) / 3) + 64;

/**
 * Estimates the decoded byte length of a percent-encoded or plain URI payload
 * without allocating decoded strings or intermediate memory.
 */
export function estimateDecodedUriBytes(payload: string): number {
	let bytes = 0;
	const len = payload.length;
	for (let i = 0; i < len; i++) {
		const ch = payload.charCodeAt(i);
		if (ch === 0x25 /* '%' */ && i + 2 < len && /^[0-9a-fA-F]{2}$/.test(payload.slice(i + 1, i + 3))) {
			bytes += 1;
			i += 2;
		} else if (ch <= 0x7f) {
			bytes += 1;
		} else if (ch <= 0x7ff) {
			bytes += 2;
		} else if (ch >= 0xd800 && ch <= 0xdbff) {
			if (i + 1 < len) {
				const next = payload.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					bytes += 4;
					i++; // consume valid low surrogate
					if (bytes > MAX_DATA_URI_BYTES) return bytes;
					continue;
				}
			}
			// Unpaired high surrogate encodes to replacement char U+FFFD (3 bytes in UTF-8)
			bytes += 3;
		} else {
			// BMP character or unpaired low surrogate (both encode to 3 bytes in UTF-8)
			bytes += 3;
		}
		if (bytes > MAX_DATA_URI_BYTES) {
			return bytes;
		}
	}
	return bytes;
}

export async function rehostAsset(
	url: string,
): Promise<{ data: Uint8Array; contentType: string; ext: string } | null> {
	// Handle data: URIs — decode directly without HTTP fetch
	if (url.startsWith("data:")) {
		const commaIdx = url.indexOf(",");
		if (commaIdx === -1) throw new Error(`Invalid data URI: no comma found`);
		const header = url.slice(5, commaIdx); // strip "data:"
		const base64 = header.endsWith(";base64");
		const mimeMatch = header.match(/^([^;]+)/);
		const contentType = mimeMatch ? mimeMatch[1] : "image/png";
		const payload = url.slice(commaIdx + 1);

		let data: Uint8Array;
		if (base64) {
			if (payload.length > MAX_DATA_URI_ENCODED_CHARS) {
				throw new Error(
					`Data URI payload (${payload.length} chars) exceeds maximum allowed size of ${MAX_DATA_URI_BYTES} bytes`,
				);
			}
			// Decode base64 in a runtime-agnostic way
			const binaryStr = atob(payload);
			if (binaryStr.length > MAX_DATA_URI_BYTES) {
				throw new Error(
					`Decoded data URI (${binaryStr.length} bytes) exceeds maximum allowed size of ${MAX_DATA_URI_BYTES} bytes`,
				);
			}
			data = new Uint8Array(binaryStr.length);
			for (let i = 0; i < binaryStr.length; i++) {
				data[i] = binaryStr.charCodeAt(i);
			}
		} else {
			const estimatedBytes = estimateDecodedUriBytes(payload);
			if (estimatedBytes > MAX_DATA_URI_BYTES) {
				throw new Error(
					`Data URI payload (${estimatedBytes} bytes) exceeds maximum allowed size of ${MAX_DATA_URI_BYTES} bytes`,
				);
			}
			data = new TextEncoder().encode(decodeURIComponent(payload));
			if (data.byteLength > MAX_DATA_URI_BYTES) {
				throw new Error(
					`Decoded data URI (${data.byteLength} bytes) exceeds maximum allowed size of ${MAX_DATA_URI_BYTES} bytes`,
				);
			}
		}

		const ext = MIME_TO_EXT[contentType] ?? ".png";
		return { data, contentType, ext };
	}

	const MAX_RETRIES = 3;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				// HTTP 4xx — do not retry
				throw new Error(
					`Failed to download asset: ${response.status} ${response.statusText}`,
				);
			}

			const buffer = await response.arrayBuffer();
			const data = new Uint8Array(buffer);
			const contentType =
				response.headers.get("content-type")?.split(";")[0]?.trim() ??
				"image/png";
			const ext = MIME_TO_EXT[contentType] ?? ".png";

			return { data, contentType, ext };
		} catch (err) {
			const isNetworkError = err instanceof TypeError;
			const isHttpError =
				err instanceof Error &&
				err.message.startsWith("Failed to download asset:");

			// Don't retry HTTP 4xx errors or the last attempt
			if (isHttpError || !isNetworkError || attempt === MAX_RETRIES) {
				if (attempt === MAX_RETRIES) {
					console.warn(
						`Failed to download asset after ${MAX_RETRIES} retries: ${url}`,
						err,
					);
					return null;
				}
				throw err;
			}

			const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
			console.warn(
				`Retry ${attempt + 1}/${MAX_RETRIES} for asset ${url} in ${delayMs}ms`,
				err,
			);
			await sleep(delayMs);
		}
	}

	return null;
}

/**
 * Compute SHA-256 hash of binary data using Web Crypto API.
 * Returns `sha256:<hex>` — same prefix convention as contentHash.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const hashBuffer = await crypto.subtle.digest("SHA-256", data as any);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256:${hashHex}`;
}

/**
 * Build the R2 key for a rehosted asset.
 */
export function assetR2Key(sha256: string, ext: string): string {
	// Strip the "sha256:" prefix for the key — it's redundant in the path
	const hex = sha256.replace(/^sha256:/, "");
	return `assets/${hex}${ext}`;
}

// ── Internal helpers ──

function isNotionUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return NOTION_HOSTS.some((nh) => host === nh || host.endsWith("." + nh));
	} catch {
		return false;
	}
}

/**
 * Strip query-string signature and hash from an expiring or signed asset URL.
 * Produces a stable base URL (origin + pathname) for matching.
 * For data: URIs, strips the payload (which can be multi-megabyte base64 data)
 * to prevent inflating canonical markdown and content hashes in failure markers.
 */
export function stripUrlSignature(url: string): string {
	if (url.startsWith("data:")) {
		const commaIdx = url.indexOf(",");
		const header = commaIdx >= 0 ? url.slice(0, commaIdx) : "data:";
		return `${header},[omitted]`;
	}
	try {
		const u = new URL(url);
		return u.origin + u.pathname;
	} catch {
		const i = url.indexOf("?");
		return i >= 0 ? url.slice(0, i) : url;
	}
}

/**
 * Rehosts asset URLs in markdown by replacing Notion/S3 URLs with their
 * canonical local asset keys (e.g. assets/<sha256>.<ext>) stored in metadata.
 */
export function rehostMarkdownAssets(
	markdown: string,
	assets: Array<{ original_url: string; r2_key: string }>,
): string {
	if (!assets || assets.length === 0) return markdown;

	let result = markdown;
	const sorted = [...assets].sort((a, b) => b.original_url.length - a.original_url.length);

	for (const asset of sorted) {
		if (!asset.original_url || !asset.r2_key) continue;

		const isDataUri = asset.original_url.startsWith("data:");
		const base = isDataUri ? asset.original_url : stripUrlSignature(asset.original_url);
		const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

		// 1. Replace markdown images: ![alt](base?query) or [![alt](base?query)](link)
		result = result.replace(
			new RegExp("(!\\[[^\\]]*\\]\\()" + escaped + "(?:\\?[^)]*)?(\\))", "g"),
			`$1${asset.r2_key}$2`,
		);

		// 2. Replace HTML img tags: <img ... src="base?query" ...> or src='base'
		result = result.replace(
			new RegExp("(<img\\b[^>]*\\ssrc=[\"'])" + escaped + "(?:\\?[^\"']*)?([\"'])", "gi"),
			`$1${asset.r2_key}$2`,
		);
	}

	return result;
}

