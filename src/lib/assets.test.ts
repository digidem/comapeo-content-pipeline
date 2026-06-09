import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	extractAssetUrls,
	rehostAsset,
	sha256Hex,
	assetR2Key,
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

		expect(result.ext).toBe(".png");
		expect(result.contentType).toBe("image/png");
		expect(result.data).toEqual(pngData);
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
		expect(result.ext).toBe(".jpg");
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
		expect(result.ext).toBe(".webp");
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
		expect(result.ext).toBe(".png");
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
		expect(result.contentType).toBe("image/png");
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
