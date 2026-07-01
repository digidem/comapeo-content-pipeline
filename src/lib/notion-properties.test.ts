import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEAD_STATUSES,
  isContentPage,
  isStructuralPage,
  normalizeLocale,
} from "./notion-properties.js";
import { mapStatus } from "./status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── DEAD_STATUSES ↔ mapStatus invariant (plan item 1.2) ──

describe("DEAD_STATUSES ↔ mapStatus consistency", () => {
  it("every DEAD_STATUSES value maps to 'deprecated' or 'archived'", () => {
    for (const status of DEAD_STATUSES) {
      const result = mapStatus(status);
      expect(
        result === "deprecated" || result === "archived",
        `Expected "${status}" to map to deprecated/archived but got "${result}"`,
      ).toBe(true);
    }
  });

  it("mapStatus('Remove') returns 'deprecated'", () => {
    expect(mapStatus("Remove")).toBe("deprecated");
  });

  it("mapStatus('Unplublished') returns 'deprecated'", () => {
    expect(mapStatus("Unplublished")).toBe("deprecated");
  });

  it("mapStatus('Unpublished') also returns 'deprecated' (covers corrected spelling)", () => {
    expect(mapStatus("Unpublished")).toBe("deprecated");
  });
});

// ── normalizeLocale (plan item 5.5) ──

describe("normalizeLocale", () => {
  // Standard full language names
  it("maps 'English' → 'en'", () => {
    expect(normalizeLocale("English")).toBe("en");
  });

  it("maps 'Portuguese' → 'pt'", () => {
    expect(normalizeLocale("Portuguese")).toBe("pt");
  });

  it("maps 'Spanish' → 'es'", () => {
    expect(normalizeLocale("Spanish")).toBe("es");
  });

  it("maps 'pt-BR' → 'pt'", () => {
    expect(normalizeLocale("pt-BR")).toBe("pt");
  });

  // Automated translation variants
  it("maps 'es - automated' → 'es'", () => {
    expect(normalizeLocale("es - automated")).toBe("es");
  });

  it("maps 'pt - automated' → 'pt'", () => {
    expect(normalizeLocale("pt - automated")).toBe("pt");
  });

  // Pass-through ISO codes already in canonical form
  it("maps 'en' → 'en'", () => {
    expect(normalizeLocale("en")).toBe("en");
  });

  it("maps 'es' → 'es'", () => {
    expect(normalizeLocale("es")).toBe("es");
  });

  it("maps 'pt' → 'pt'", () => {
    expect(normalizeLocale("pt")).toBe("pt");
  });

  // Passthrough lowercased for unknown values
  it("lowercases unknown locale values", () => {
    expect(normalizeLocale("FR")).toBe("fr");
    expect(normalizeLocale("ZH-CN")).toBe("zh-cn");
  });

  // Null / undefined handling
  it("returns 'en' for null", () => {
    expect(normalizeLocale(null)).toBe("en");
  });

  it("returns 'en' for undefined", () => {
    expect(normalizeLocale(undefined)).toBe("en");
  });

  it("returns 'en' for empty string", () => {
    expect(normalizeLocale("")).toBe("en");
  });
});

// ── Element-type helpers (plan item 5.6) ──

describe("isContentPage", () => {
  it("returns true for 'page'", () => {
    expect(isContentPage("page")).toBe(true);
  });

  it("returns true for 'Page' (case-insensitive)", () => {
    expect(isContentPage("Page")).toBe(true);
  });

  it("returns true for empty string (no element type)", () => {
    expect(isContentPage("")).toBe(true);
  });

  it("returns false for 'toggle'", () => {
    expect(isContentPage("toggle")).toBe(false);
  });

  it("returns false for 'title'", () => {
    expect(isContentPage("title")).toBe(false);
  });

  it("returns false for unknown types", () => {
    expect(isContentPage("database")).toBe(false);
  });
});

describe("isStructuralPage", () => {
  it("returns true for 'toggle'", () => {
    expect(isStructuralPage("toggle")).toBe(true);
  });

  it("returns true for 'Toggle' (case-insensitive)", () => {
    expect(isStructuralPage("Toggle")).toBe(true);
  });

  it("returns true for 'title'", () => {
    expect(isStructuralPage("title")).toBe(true);
  });

  it("returns true for 'Title' (case-insensitive)", () => {
    expect(isStructuralPage("Title")).toBe(true);
  });

  it("returns false for 'page'", () => {
    expect(isStructuralPage("page")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isStructuralPage("")).toBe(false);
  });
});

// ── Guard: no stale DRAFTING_STATUS references or inline property strings (plan item 5.9) ──

/**
 * Recursively collect all .ts files under a directory, excluding .test.ts files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("constants guard (plan 5.9)", () => {
  const srcDir = join(__dirname, "../..");  // repo root/src/../..  → we want src/
  const srcRoot = join(__dirname, "..");    // one level up from lib → src/

  it("no source file outside notion-properties.ts references DRAFTING_STATUS", () => {
    const sourceFiles = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const f of sourceFiles) {
      if (f.endsWith("notion-properties.ts")) continue;
      const content = readFileSync(f, "utf8");
      if (content.includes("DRAFTING_STATUS")) {
        violations.push(f.replace(srcRoot, "src"));
      }
    }
    expect(
      violations,
      `DRAFTING_STATUS found in: ${violations.join(", ")}`,
    ).toHaveLength(0);
  });

  it("no source file outside notion-properties.ts has inline 'Publish Status' string literal", () => {
    const sourceFiles = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const f of sourceFiles) {
      if (f.endsWith("notion-properties.ts")) continue;
      const content = readFileSync(f, "utf8");
      // Match the exact property name as a quoted string literal
      if (/["']Publish Status["']/.test(content)) {
        violations.push(f.replace(srcRoot, "src"));
      }
    }
    expect(
      violations,
      `Inline "Publish Status" found in: ${violations.join(", ")}`,
    ).toHaveLength(0);
  });

  it("no source file outside notion-properties.ts has inline 'Keywords' string literal", () => {
    const sourceFiles = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const f of sourceFiles) {
      if (f.endsWith("notion-properties.ts")) continue;
      const content = readFileSync(f, "utf8");
      if (/["']Keywords["']/.test(content)) {
        violations.push(f.replace(srcRoot, "src"));
      }
    }
    expect(
      violations,
      `Inline "Keywords" found in: ${violations.join(", ")}`,
    ).toHaveLength(0);
  });

  it("no source file outside notion-properties.ts has inline 'Tags' string literal", () => {
    const sourceFiles = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const f of sourceFiles) {
      if (f.endsWith("notion-properties.ts")) continue;
      const content = readFileSync(f, "utf8");
      if (/["']Tags["']/.test(content)) {
        violations.push(f.replace(srcRoot, "src"));
      }
    }
    expect(
      violations,
      `Inline "Tags" found in: ${violations.join(", ")}`,
    ).toHaveLength(0);
  });

  it("no source file outside notion-properties.ts has inline 'Date Published' string literal", () => {
    const sourceFiles = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const f of sourceFiles) {
      if (f.endsWith("notion-properties.ts")) continue;
      const content = readFileSync(f, "utf8");
      if (/["']Date Published["']/.test(content)) {
        violations.push(f.replace(srcRoot, "src"));
      }
    }
    expect(
      violations,
      `Inline "Date Published" found in: ${violations.join(", ")}`,
    ).toHaveLength(0);
  });
});
