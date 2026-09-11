import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	extractAssetUrls,
	rehostAsset,
	sha256Hex,
	assetR2Key,
	stripUrlSignature,
	rehostMarkdownAssets,
} from "./assets.js";

// ── extractAssetUrls ──

describe("extractAssetUrls", () => {
	it("extracts a single image URL", () => {
		const md = "![alt](https://example.com/img.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	it("extracts multiple image URLs", () => {
		const md = "![a](https://a.com/a.png)\n\n![b](https://b.com/b.jpg)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(2);
		expect(results[0].url).toBe("https://a.com/a.png");
		expect(results[1].url).toBe("https://b.com/b.jpg");
	});

	it("identifies Notion S3 URLs", () => {
		const md = "![img](https://s3.us-west-2.amazonaws.com/secure.notion-static.com/abc.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(true);
	});

	it("identifies secure.notion-static.com URLs", () => {
		const md = "![img](https://secure.notion-static.com/abc123.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(true);
	});

	it("identifies prod-files-secure S3 URLs", () => {
		const md = "![img](https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/abc.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(true);
	});

	it("identifies notion.so URLs", () => {
		const md = "![img](https://notion.so/image/abc.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(true);
	});

	it("marks non-Notion URLs as isNotion=false", () => {
		const md = "![img](https://cdn.example.com/img.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(false);
	});

	it("returns empty array for markdown with no images", () => {
		const md = "Just text with [a link](https://example.com)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(0);
	});

	it("handles mixed Notion and external URLs", () => {
		const md =
			"![ext](https://cdn.example.com/a.png)\n\n![notion](https://secure.notion-static.com/b.png)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(2);
		expect(results[0].isNotion).toBe(false);
		expect(results[1].isNotion).toBe(true);
	});

	// ── HTML img tags (Issue 4.6) ──

	it("extracts URL from HTML img tag with double quotes", () => {
		const md = '<img src="https://example.com/img.png" alt="photo">';
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	it("extracts URL from HTML img tag with single quotes", () => {
		const md = "<img src='https://example.com/img.png' alt='photo'>";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	it("extracts URL from HTML img tag with additional attributes", () => {
		const md =
			'<img class="hero" src="https://example.com/hero.png" width="800" height="600" />';
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/hero.png");
	});

	it("extracts URL from self-closing HTML img tag", () => {
		const md = '<img src="https://example.com/icon.svg"/>';
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/icon.svg");
	});

	it("identifies Notion URLs in HTML img tags", () => {
		const md =
			'<img src="https://secure.notion-static.com/abc.png" alt="notion-img">';
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].isNotion).toBe(true);
	});

	// ── Hyperlinked images (Issue 4.7) ──

	it("extracts inner image URL from hyperlinked image", () => {
		const md = "[![alt](https://example.com/img.png)](https://example.com/link)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	it("extracts inner image URL from hyperlinked Notion image", () => {
		const md =
			"[![screenshot](https://secure.notion-static.com/abc.png)](https://example.com/page)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://secure.notion-static.com/abc.png");
		expect(results[0].isNotion).toBe(true);
	});

	it("does not extract the link URL from hyperlinked image", () => {
		const md = "[![alt](https://example.com/img.png)](https://example.com/page)";
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	// ── Deduplication ──

	it("deduplicates URLs extracted from multiple patterns", () => {
		const md =
			'![alt](https://example.com/img.png)\n\n<img src="https://example.com/img.png">';
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/img.png");
	});

	it("handles all three patterns in the same markdown", () => {
		const md = [
			"![md](https://a.com/a.png)",
			"[![linked](https://b.com/b.png)](https://example.com)",
			'<img src="https://c.com/c.png">',
		].join("\n\n");
		const results = extractAssetUrls(md);
		expect(results).toHaveLength(3);
		// Hyperlinked images are extracted first, then plain markdown, then HTML
		expect(results.map((r) => r.url)).toEqual([
			"https://b.com/b.png",
			"https://a.com/a.png",
			"https://c.com/c.png",
		]);
	});
});

// ── sha256Hex ──

describe("sha256Hex", () => {
	it("produces sha256-prefixed hex string", async () => {
		const data = new Uint8Array([1, 2, 3]);
		const hash = await sha256Hex(data);
		expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("is deterministic", async () => {
		const data = new Uint8Array([42]);
		const a = await sha256Hex(data);
		const b = await sha256Hex(data);
		expect(a).toBe(b);
	});

	it("different inputs produce different hashes", async () => {
		const a = await sha256Hex(new Uint8Array([1]));
		const b = await sha256Hex(new Uint8Array([2]));
		expect(a).not.toBe(b);
	});
});

// ── rehostAsset ──

describe("rehostAsset", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("decodes valid base64 data URI directly without HTTP fetch", async () => {
		const dataUri = "data:image/png;base64,iVBORw0KGgo=";
		const result = await rehostAsset(dataUri);
		expect(result!.contentType).toBe("image/png");
		expect(result!.ext).toBe(".png");
		expect(result!.data.byteLength).toBeGreaterThan(0);
	});

	it("rejects oversized data URIs before decoding to prevent memory exhaustion", async () => {
		const oversizedBase64 = "data:image/png;base64," + "A".repeat(15 * 1024 * 1024);
		await expect(rehostAsset(oversizedBase64)).rejects.toThrow(/exceeds maximum allowed size/);
	});

	it("downloads asset and maps content type to extension", async () => {
		const pngData = new Uint8Array([137, 80, 78, 71]);
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/png" }),
			arrayBuffer: () => Promise.resolve(pngData.buffer),
		});

		vi.stubGlobal("fetch", mockFetch);
		const result = await rehostAsset("https://example.com/img.png");

		expect(result!.ext).toBe(".png");
		expect(result!.contentType).toBe("image/png");
		expect(result!.data).toEqual(pngData);
	});

	it("maps jpeg to .jpg", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/jpeg" }),
			arrayBuffer: () => Promise.resolve(new Uint8Array([0xff]).buffer),
		});

		vi.stubGlobal("fetch", mockFetch);
		const result = await rehostAsset("https://example.com/img.jpg");
		expect(result!.ext).toBe(".jpg");
	});

	it("maps webp to .webp", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/webp" }),
			arrayBuffer: () => Promise.resolve(new Uint8Array([0]).buffer),
		});

		vi.stubGlobal("fetch", mockFetch);
		const result = await rehostAsset("https://example.com/img.webp");
		expect(result!.ext).toBe(".webp");
	});

	it("defaults to .png for unknown content type", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/octet-stream" }),
			arrayBuffer: () => Promise.resolve(new Uint8Array([0]).buffer),
		});

		vi.stubGlobal("fetch", mockFetch);
		const result = await rehostAsset("https://example.com/img.bin");
		expect(result!.ext).toBe(".png");
	});

	it("strips charset from content-type", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/png; charset=binary" }),
			arrayBuffer: () => Promise.resolve(new Uint8Array([0]).buffer),
		});

		vi.stubGlobal("fetch", mockFetch);
		const result = await rehostAsset("https://example.com/img.png");
		expect(result!.contentType).toBe("image/png");
	});

	it("throws on non-2xx response", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			headers: new Headers(),
		});

		vi.stubGlobal("fetch", mockFetch);
		await expect(rehostAsset("https://example.com/img.png")).rejects.toThrow(
			"Failed to download asset: 403 Forbidden",
		);
	});

	it("returns null after retries exhausted on network error", async () => {
		mockFetch.mockClear();
		mockFetch.mockRejectedValue(new TypeError("fetch failed"));

		vi.stubGlobal("fetch", mockFetch);
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const promise = rehostAsset("https://example.com/img.png");

		// Advance through all retry delays
		await vi.advanceTimersByTimeAsync(10000);

		const result = await promise;
		expect(result).toBeNull();
		expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		vi.useRealTimers();
	});

	it("retries on network error and succeeds on second attempt", async () => {
		const pngData = new Uint8Array([137, 80, 78, 71]);
		mockFetch.mockClear();
		mockFetch
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "image/png" }),
				arrayBuffer: () => Promise.resolve(pngData.buffer),
			});

		vi.stubGlobal("fetch", mockFetch);
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const promise = rehostAsset("https://example.com/img.png");

		await vi.advanceTimersByTimeAsync(2000);

		const result = await promise;
		expect(result).not.toBeNull();
		expect(result!.data).toEqual(pngData);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("does not retry HTTP 4xx errors", async () => {
		mockFetch.mockClear();
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 404,
			statusText: "Not Found",
			headers: new Headers(),
		});

		vi.stubGlobal("fetch", mockFetch);

		await expect(rehostAsset("https://example.com/img.png")).rejects.toThrow(
			"Failed to download asset: 404 Not Found",
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});

// ── assetR2Key ──

describe("assetR2Key", () => {
	it("builds correct R2 key", () => {
		const key = assetR2Key("sha256:abc123", ".png");
		expect(key).toBe("assets/abc123.png");
	});

	it("strips sha256 prefix", () => {
		const key = assetR2Key(
			"sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			".jpg",
		);
		expect(key).toBe(
			"assets/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.jpg",
		);
	});
});

// ── stripUrlSignature ──

describe("stripUrlSignature", () => {
	it("strips query string from URL", () => {
		const url = "https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/photo.jpg?X-Amz-Algorithm=AWS4&X-Amz-Signature=123";
		expect(stripUrlSignature(url)).toBe("https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/photo.jpg");
	});

	it("returns identical URL if no query string present", () => {
		const url = "https://example.com/images/icon.png";
		expect(stripUrlSignature(url)).toBe("https://example.com/images/icon.png");
	});

	it("handles malformed URLs with question marks gracefully", () => {
		const malformed = "not-a-valid-url/path?query=val";
		expect(stripUrlSignature(malformed)).toBe("not-a-valid-url/path");
	});

	it("preserves data URIs without corrupting them into null paths", () => {
		const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
		expect(stripUrlSignature(dataUri)).toBe(dataUri);
	});
});

// ── rehostMarkdownAssets ──

describe("rehostMarkdownAssets", () => {
	const assets = [
		{
			original_url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/switch_projects.jpg?X-Amz-Date=20260723T103534Z&X-Amz-Signature=abc",
			r2_key: "assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg",
		},
		{
			original_url: "https://s3-us-west-2.amazonaws.com/public.notion-static.com/uuid/photo_2026-04-18_09-03-07.jpg",
			r2_key: "assets/ce83f9d3ea687047295a17cb3e9e090b3f7b1e1196ac2c200404927cae1c1a25.jpg",
		},
	];

	it("rehosts standard markdown images even with refreshed signature", () => {
		const md = "![image](https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/uuid/switch_projects.jpg?X-Amz-Date=20260910T120000Z&X-Amz-Signature=xyz)";
		const result = rehostMarkdownAssets(md, assets);
		expect(result).toBe("![image](assets/ab2b210fb2fbe7db8225bbd0cefd33bb92d003c9fb8b3ca73a17f3703d2a38d4.jpg)");
	});

	it("rehosts inline HTML img tags", () => {
		const md = 'Click on <img src="https://s3-us-west-2.amazonaws.com/public.notion-static.com/uuid/photo_2026-04-18_09-03-07.jpg" alt="switch" className="emoji" style={{display:"inline"}} /> to switch';
		const result = rehostMarkdownAssets(md, assets);
		expect(result).toBe('Click on <img src="assets/ce83f9d3ea687047295a17cb3e9e090b3f7b1e1196ac2c200404927cae1c1a25.jpg" alt="switch" className="emoji" style={{display:"inline"}} /> to switch');
	});

	it("leaves non-matching images untouched", () => {
		const md = "![other](https://example.com/other.jpg)";
		const result = rehostMarkdownAssets(md, assets);
		expect(result).toBe(md);
	});

	it("returns original text when assets list is empty", () => {
		const md = "![img](https://example.com/img.png)";
		expect(rehostMarkdownAssets(md, [])).toBe(md);
	});
});
