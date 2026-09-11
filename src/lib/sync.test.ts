import { describe, it, expect, vi, afterEach } from "vitest";
import { convertPageData, stripUrlSignature } from "./sync.js";
import { contentHash } from "./hash.js";
import { parseDoc } from "./frontmatter.js";
import type { NotionBlockList } from "./notion-converter.js";

/**
 * Regression coverage for content_hash stability across signed-asset URLs.
 *
 * Pre-rehost Notion S3 URLs carry X-Amz-Signature params that change every
 * fetch; the hash must be computed on the canonical (post-rehost) markdown so
 * it does not flap. See sync.ts::convertPageData.
 */

// Default annotations object — richTextToMarkdown reads these fields directly
// (no optional chaining), so a full object is required.
const DEFAULT_ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

// Minimal Notion page object. sync.ts only reads .last_edited_time and a
// title property (extractTitle tries "Content elements" first).
function makeRawPage(title = "Hash Stability Test"): Record<string, unknown> {
  return {
    last_edited_time: "2026-07-07T00:00:00.000Z",
    properties: {
      "Content elements": {
        title: [{ plain_text: title }],
      },
    },
  };
}

// A signed Notion S3 URL — only the X-Amz-Signature query param varies between
// syncs. Host is in NOTION_HOSTS, so extractAssetUrls flags it isNotion.
function signedImageUrl(signature: string): string {
  return (
    "https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/img.png" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260101T000000Z" +
    `&X-Amz-Signature=${signature}`
  );
}

function makeRawBlocks(opts: {
  text?: string;
  signature?: string;
} = {}): NotionBlockList {
  const text = opts.text ?? "Hello world";
  const sig = opts.signature ?? "aaa";
  return {
    object: "list",
    results: [
      {
        object: "block",
        id: "p1",
        type: "paragraph",
        has_children: false,
        paragraph: {
          rich_text: [
            {
              type: "text",
              plain_text: text,
              text: { content: text },
              annotations: { ...DEFAULT_ANNOTATIONS },
            },
          ],
        },
      },
      {
        object: "block",
        id: "img1",
        type: "image",
        has_children: false,
        image: {
          type: "file",
          file: { url: signedImageUrl(sig) },
          caption: [],
        },
      },
    ],
    children: {},
  };
}

// Stub global fetch → a tiny fake PNG. A fresh Response is created per call so
// the body stream can be consumed once per asset download without error.
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ),
  );
}

// Stub global fetch to fail every request (HTTP 502) → asset download fails →
// rehostAsset throws (4xx, not retried) → the signed Notion URL is left in the
// body, exercising the failed-asset neutralization path.
function failingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response("Bad Gateway", {
          status: 502,
          statusText: "Bad Gateway",
        }),
    ),
  );
}

describe("content_hash stability (signed asset URLs)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is identical across two syncs whose only difference is the URL signature", async () => {
    stubFetch();
    const a = await convertPageData({
      pageId: "page-aaa",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ signature: "aaa" }),
      usedSlugs: new Set<string>(),
    });
    const b = await convertPageData({
      pageId: "page-bbb",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ signature: "bbb" }),
      usedSlugs: new Set<string>(),
    });
    // Signed URLs differ (aaa vs bbb) but rehost to the same content-addressed
    // assets/<sha256> path, so the canonical markdown — and its hash — match.
    expect(a.metadata.content_hash).toBe(b.metadata.content_hash);
  });

  it("equals contentHash of the emitted canonical markdown body", async () => {
    stubFetch();
    const result = await convertPageData({
      pageId: "page-canonical",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks(),
      usedSlugs: new Set<string>(),
    });
    // Field name `canoncialMd` is an existing typo in SyncPageOutput — kept.
    const { body } = parseDoc(result.canoncialMd);
    expect(await contentHash(body)).toBe(result.metadata.content_hash);
  });

  it("changes when the actual text content changes", async () => {
    stubFetch();
    const a = await convertPageData({
      pageId: "page-text1",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ text: "Original text" }),
      usedSlugs: new Set<string>(),
    });
    const b = await convertPageData({
      pageId: "page-text2",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ text: "Edited text" }),
      usedSlugs: new Set<string>(),
    });
    expect(a.metadata.content_hash).not.toBe(b.metadata.content_hash);
  });
});

describe("failed-asset marker signature stripping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("yields identical content_hash and canonical markdown across two signatures", async () => {
    failingFetch();
    // Same page (same pageId); only the URL signature differs. Pre-fix the
    // marker embedded the full signed URL → hash flapped. Now the marker is
    // signature-stripped → both syncs converge.
    const a = await convertPageData({
      pageId: "page-fail",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ signature: "aaa" }),
      usedSlugs: new Set<string>(),
    });
    const b = await convertPageData({
      pageId: "page-fail",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ signature: "bbb" }),
      usedSlugs: new Set<string>(),
    });
    expect(a.metadata.content_hash).toBe(b.metadata.content_hash);
    expect(a.canoncialMd).toBe(b.canoncialMd);
  });

  it("strips the query string from the marker but keeps origin + pathname", async () => {
    failingFetch();
    const result = await convertPageData({
      pageId: "page-fail-strip",
      rawPage: makeRawPage(),
      rawBlocks: makeRawBlocks({ signature: "deadbeef" }),
      usedSlugs: new Set<string>(),
    });
    const { body } = parseDoc(result.canoncialMd);
    // No expiring-signature / query-string remnant ships in the canonical body.
    expect(body).not.toContain("X-Amz");
    expect(body).not.toContain("Signature");
    expect(body).not.toContain("?");
    // Origin + pathname are preserved so the marker still names which asset failed.
    expect(body).toContain(
      "<!-- failed-asset: https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/img.png -->",
    );
  });

  it("falls back to a literal `?` split for an unparseable URL", () => {
    // Space in the host makes new URL() throw → fallback path strips from the
    // first `?`, keeping the segment before it.
    expect(stripUrlSignature("https://exa mple.com/path?sig=secret")).toBe(
      "https://exa mple.com/path",
    );
    // No `?` at all → returned unchanged by the fallback path.
    expect(stripUrlSignature("not-a-url")).toBe("not-a-url");
  });

  it("neutralizes linked images cleanly without leaving outer link wrapped around failure marker", async () => {
    failingFetch();
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-linked",
          type: "image",
          has_children: false,
          image: {
            type: "file",
            file: { url: signedImageUrl("sig-linked") },
            link: { url: "https://example.com/destination" },
            caption: [
              {
                type: "text",
                plain_text: "Linked diagram",
                text: { content: "Linked diagram" },
                annotations: { ...DEFAULT_ANNOTATIONS },
              },
            ],
          },
        },
      ],
      children: {},
    };

    const result = await convertPageData({
      pageId: "page-fail-linked",
      rawPage: makeRawPage(),
      rawBlocks,
      usedSlugs: new Set<string>(),
    });

    const { body } = parseDoc(result.canoncialMd);
    // Outer link markdown construct must not wrap the multiline failure marker
    expect(body).not.toContain("](https://example.com/destination)");
    expect(body).toContain("**[Image unavailable: Linked diagram]**");
    expect(body).toContain(
      "<!-- failed-asset: https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/img.png -->",
    );
  });

  it("neutralizes linked images cleanly when destination contains closing parentheses", async () => {
    failingFetch();
    const rawBlocks: NotionBlockList = {
      object: "list",
      results: [
        {
          object: "block",
          id: "img-paren-dest",
          type: "image",
          has_children: false,
          image: {
            type: "file",
            file: { url: signedImageUrl("sig-paren-dest") },
            link: { url: "https://en.wikipedia.org/wiki/Flowchart_(computer_programming)" },
            caption: [
              {
                type: "text",
                plain_text: "Flowchart link with parens",
                text: { content: "Flowchart link with parens" },
                annotations: { ...DEFAULT_ANNOTATIONS },
              },
            ],
          },
        },
      ],
      children: {},
    };

    const result = await convertPageData({
      pageId: "page-fail-paren-dest",
      rawPage: makeRawPage(),
      rawBlocks,
      usedSlugs: new Set<string>(),
    });

    const { body } = parseDoc(result.canoncialMd);
    // Verified the entire outer link with parens is neutralized
    expect(body).not.toContain("https://en.wikipedia.org/wiki/Flowchart");
    expect(body).not.toContain("(computer_programming)");
    expect(body).toContain("**[Image unavailable: Flowchart link with parens]**");
    expect(body).toContain(
      "<!-- failed-asset: https://prod-files-secure.s3.us-west-2.amazonaws.com/bucket/img.png -->",
    );
  });
});
