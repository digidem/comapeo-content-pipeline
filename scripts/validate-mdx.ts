import fs from "node:fs";
import path from "node:path";
import { compile, run } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import React from "react";
import ReactDOMServer from "react-dom/server";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

export interface MdxValidationError {
  line?: number;
  column?: number;
  message: string;
  snippet?: string;
}

export interface MdxValidationResult {
  filePath?: string;
  valid: boolean;
  errors: MdxValidationError[];
}

export interface MdxBatchSummary {
  total: number;
  passed: number;
  failed: number;
  results: MdxValidationResult[];
}

export interface ValidateMdxOptions {
  filePath?: string;
  components?: Record<string, React.ComponentType<unknown>>;
}

/**
 * Extracts line and column numbers from MDX / VFile / React error objects or messages.
 */
function extractLocation(err: unknown, source: string): { line?: number; column?: number } {
  if (!err || typeof err !== "object") return {};

  const errorObj = err as {
    line?: number;
    column?: number;
    place?: { line?: number; column?: number };
    position?: { start?: { line?: number; column?: number } };
    message?: string;
    reason?: string;
  };

  const message = errorObj.reason || errorObj.message || "";

  // 1. Check parenthetical line:col in message (e.g., "(2:1-2:15)" or "(14:5)")
  const parenMatch = message.match(/\((\d+):(\d+)(?:-\d+:\d+)?\)/);
  if (parenMatch) {
    return {
      line: parseInt(parenMatch[1], 10),
      column: parseInt(parenMatch[2], 10),
    };
  }

  // 2. Direct property on VFile error
  if (errorObj.place?.line) {
    return { line: errorObj.place.line, column: errorObj.place.column };
  }
  if (errorObj.position?.start?.line) {
    return { line: errorObj.position.start.line, column: errorObj.position.start.column };
  }
  if (typeof errorObj.line === "number" && errorObj.line > 0) {
    return { line: errorObj.line, column: errorObj.column };
  }

  // 3. Fallback for string/bare style prop React SSR error
  if (/style.*prop expects a mapping/i.test(message)) {
    const lines = source.split("\n");
    const styleLineIdx = lines.findIndex((l) => /\bstyle=(?!\{\{)/.test(l));
    if (styleLineIdx !== -1) {
      return { line: styleLineIdx + 1, column: 1 };
    }
  }

  return {};
}

/**
 * Validate markdown content against real MDX parser and React SSR compiler harness.
 */
export async function validateMdxContent(
  content: string,
  options?: ValidateMdxOptions
): Promise<MdxValidationResult> {
  const filePath = options?.filePath;

  try {
    const compiled = await compile(content, {
      outputFormat: "function-body",
      remarkPlugins: [remarkFrontmatter, remarkGfm],
    });

    const { default: MDXContent } = await run(compiled, {
      ...runtime,
    });

    // Suppress console.error / console.warn during static render validation
    // to avoid noise from React warnings like invalid DOM properties (e.g. `class` vs `className`).
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};

    try {
      ReactDOMServer.renderToStaticMarkup(
        React.createElement(MDXContent, {
          components: options?.components,
        })
      );
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    return {
      filePath,
      valid: true,
      errors: [],
    };
  } catch (err: unknown) {
    const loc = extractLocation(err, content);
    const rawMessage = (err as Error)?.message || String(err);
    // Strip stack trace noise if present
    const message = rawMessage.split("\n")[0] || rawMessage;

    let snippet: string | undefined;
    if (loc.line && loc.line > 0) {
      const lines = content.split("\n");
      const targetLine = lines[loc.line - 1];
      if (targetLine !== undefined) {
        snippet = targetLine.trim().slice(0, 140);
      }
    }

    return {
      filePath,
      valid: false,
      errors: [
        {
          line: loc.line,
          column: loc.column,
          message,
          snippet,
        },
      ],
    };
  }
}

/**
 * Validate a single file path on disk.
 */
export async function validateMdxFile(
  filePath: string,
  options?: Omit<ValidateMdxOptions, "filePath">
): Promise<MdxValidationResult> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  return validateMdxContent(content, { ...options, filePath });
}

/**
 * Recursively find markdown files in target paths.
 */
export function findMarkdownFiles(targetPath: string): string[] {
  if (!fs.existsSync(targetPath)) return [];

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return /\.(md|mdx)$/i.test(targetPath) ? [targetPath] : [];
  }

  const results: string[] = [];
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "dist") {
        results.push(...findMarkdownFiles(fullPath));
      }
    } else if (/\.(md|mdx)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

/**
 * Validate a list of markdown files.
 */
export async function validateMdxFiles(
  filePaths: string[],
  options?: Omit<ValidateMdxOptions, "filePath">
): Promise<MdxBatchSummary> {
  const results: MdxValidationResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const file of filePaths) {
    const result = await validateMdxFile(file, options);
    if (result.valid) {
      passed++;
    } else {
      failed++;
    }
    results.push(result);
  }

  return {
    total: filePaths.length,
    passed,
    failed,
    results,
  };
}

/**
 * CLI Entrypoint
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let targets = args;

  if (targets.length === 0) {
    // Default discovery: validate output/docs (if present) and test/fixtures/expected
    const defaultDirs = ["test/fixtures/expected", "output/docs"];
    targets = defaultDirs.filter((d) => fs.existsSync(d));
  }

  const allFiles = targets.flatMap((t) => findMarkdownFiles(t));

  if (allFiles.length === 0) {
    console.log("ℹ️  No markdown files found to validate.");
    process.exit(0);
  }

  console.log(`🔍 Validating ${allFiles.length} markdown file(s) against real MDX/SSR compiler...`);

  const summary = await validateMdxFiles(allFiles);

  let failureCount = 0;
  for (const result of summary.results) {
    if (!result.valid) {
      failureCount++;
      const fileLabel = result.filePath || "unknown";
      for (const err of result.errors) {
        const lineCol = err.line ? `:${err.line}${err.column ? `:${err.column}` : ""}` : "";
        console.error(`❌ ${fileLabel}${lineCol} — ${err.message}`);
        if (err.snippet) {
          console.error(`   | ${err.snippet}`);
        }
      }
    }
  }

  console.log("");
  if (failureCount === 0) {
    console.log(`✅ All ${summary.passed} file(s) passed MDX validation.`);
    process.exit(0);
  } else {
    console.error(`💥 ${failureCount} of ${summary.total} file(s) failed MDX validation.`);
    process.exit(1);
  }
}

// Execute when invoked directly
const isDirectlyExecuted =
  (typeof process !== "undefined" &&
    process.argv[1] &&
    (process.argv[1].endsWith("validate-mdx.ts") || process.argv[1].endsWith("validate-mdx.js"))) ||
  (typeof import.meta !== "undefined" && (import.meta as { main?: boolean }).main);

if (isDirectlyExecuted) {
  main().catch((err) => {
    console.error("Fatal MDX validation error:", err);
    process.exit(1);
  });
}
