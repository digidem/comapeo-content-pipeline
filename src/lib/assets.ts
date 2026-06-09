/**
 * Asset rehosting: extract, download, and hash image URLs from Notion.
 *
 * Runtime-agnostic — uses Web Crypto API (available in Workers and Node 19+).
 */

export interface ExtractedAsset {
	url: string;
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
 */
export function extractAssetUrls(markdown: string): ExtractedAsset[] {
	const results: ExtractedAsset[] = [];
	const pattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(markdown)) !== null) {
		const url = match[2];
		results.push({ url, isNotion: isNotionUrl(url) });
	}

	return results;
}

/**
 * Download an asset and return its binary data, content type, and extension.
 */
export async function rehostAsset(
	url: string,
): Promise<{ data: Uint8Array; contentType: string; ext: string }> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to download asset: ${response.status} ${response.statusText}`);
	}

	const buffer = await response.arrayBuffer();
	const data = new Uint8Array(buffer);
	const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/png";
	const ext = MIME_TO_EXT[contentType] ?? ".png";

	return { data, contentType, ext };
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
