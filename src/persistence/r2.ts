/**
 * R2 storage abstraction.
 *
 * Provides a pluggable interface for R2 operations. In local/CI mode,
 * uses the filesystem. On Cloudflare Workers, uses the R2 binding.
 */

export interface StorageBackend {
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
}

// ── Filesystem backend (local dev / CI) ──

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

export class FilesystemStorage implements StorageBackend {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  async put(key: string, body: string | Uint8Array, _contentType?: string): Promise<void> {
    const path = join(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : Buffer.from(body));
  }

  async get(key: string): Promise<string | null> {
    const path = join(this.root, key);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  async delete(key: string): Promise<void> {
    const path = join(this.root, key);
    if (existsSync(path)) unlinkSync(path);
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const dir = join(this.root, prefix);
    if (!existsSync(dir)) return [];
    const results: Array<{ key: string; size: number }> = [];

    const walk = (current: string) => {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          const stats = statSync(fullPath);
          results.push({
            key: fullPath.replace(this.root + "/", ""),
            size: stats.size,
          });
        }
      }
    };

    walk(dir);
    return results;
  }
}

// ── R2 artifact paths ──

export const R2_PATHS = {
  manifest: "manifests/latest.json",
  manifestVersion: (timestamp: string) => `manifests/versions/${timestamp}.json`,
  doc: (locale: string, section: string | null, slug: string) => {
    const sectionPrefix = section ? `${section}/` : "";
    return `docs/${locale}/docs/${sectionPrefix}${slug}.md`;
  },
  metadata: (pageId: string) => `pages/${pageId}/metadata.json`,
  rawPage: (pageId: string) => `pages/${pageId}/raw-page.json`,
  rawBlocks: (pageId: string) => `pages/${pageId}/raw-blocks.json`,
  sidebar: (locale: string) => `sidebars/${locale}.json`,
  ragChunk: (chunkId: string) => `rag/chunks/${chunkId}.json`,
  ragChunksManifest: "rag/chunks-manifest.json",
  asset: (sha256: string, ext: string) => `assets/${sha256}${ext}`,
} as const;

/**
 * Write all artifacts for a synced page.
 */
export async function writePageArtifacts(
  storage: StorageBackend,
  pageId: string,
  metadata: Record<string, unknown>,
  canoncialMd: string,
  rawPage: unknown,
  rawBlocks: unknown,
): Promise<void> {
  const locale = (metadata.locale as string) || "en";
  const section = (metadata.section as string | null) || null;
  const slug = (metadata.slug as string) || pageId;

  await Promise.all([
    storage.put(
      R2_PATHS.metadata(pageId),
      JSON.stringify(metadata, null, 2),
      "application/json",
    ),
    storage.put(
      R2_PATHS.doc(locale, section, slug),
      canoncialMd,
      "text/markdown",
    ),
    storage.put(
      R2_PATHS.rawPage(pageId),
      JSON.stringify(rawPage, null, 2),
      "application/json",
    ),
    storage.put(
      R2_PATHS.rawBlocks(pageId),
      JSON.stringify(rawBlocks, null, 2),
      "application/json",
    ),
  ]);
}

/**
 * Write manifest to R2.
 */
export async function writeManifest(
  storage: StorageBackend,
  manifest: Record<string, unknown>,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const body = JSON.stringify(manifest, null, 2);

  await Promise.all([
    storage.put(R2_PATHS.manifest, body, "application/json"),
    storage.put(R2_PATHS.manifestVersion(timestamp), body, "application/json"),
  ]);
}

/**
 * Read the current manifest from R2.
 */
export async function readManifest(
  storage: StorageBackend,
): Promise<Record<string, unknown> | null> {
  const raw = await storage.get(R2_PATHS.manifest);
  if (!raw) return null;
  return JSON.parse(raw);
}
