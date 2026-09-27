import fs from "node:fs";
import path from "node:path";
import {
  runEditorialLinter,
  type EditorialLinterPageInput,
} from "../lib/editorial-linter.js";
import {
  EditorialDiagnosticsReportSchema,
  type EditorialDiagnosticsReport,
} from "../schemas/index.js";

export interface EditorialDiagnosticsCliOptions {
  out?: string;
  jsonOnly?: boolean;
}

/**
 * Load documentation pages from the output directory.
 */
export function loadPagesFromOutput(outputDir: string): EditorialLinterPageInput[] {
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const entries = fs.readdirSync(outputDir);
  const metadataFiles = entries.filter((f) => f.endsWith(".metadata.json"));
  const pages: EditorialLinterPageInput[] = [];

  for (const metaFile of metadataFiles) {
    const pageId = metaFile.replace(/\.metadata\.json$/, "");
    const metaPath = path.join(outputDir, metaFile);
    const mdPath = path.join(outputDir, `${pageId}.md`);
    const rawBlocksPath = path.join(outputDir, `${pageId}.raw-blocks.json`);

    try {
      const metaContent = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      let markdown = "";
      if (fs.existsSync(mdPath)) {
        markdown = fs.readFileSync(mdPath, "utf-8");
      }

      let rawBlocks: unknown = undefined;
      if (fs.existsSync(rawBlocksPath)) {
        try {
          rawBlocks = JSON.parse(fs.readFileSync(rawBlocksPath, "utf-8"));
        } catch {
          // Ignore invalid raw-blocks JSON
        }
      }

      pages.push({
        pageId,
        title: metaContent.title || "Untitled",
        slug: metaContent.slug || pageId,
        locale: metaContent.locale || "en",
        markdown,
        rawBlocks,
      });
    } catch {
      // Ignore unparseable metadata files
    }
  }

  return pages;
}

/**
 * Print a readable console summary table for editors.
 */
function printReportSummary(report: EditorialDiagnosticsReport): void {
  console.log("\n=======================================================");
  console.log("       NOTION EDITORIAL DIAGNOSTICS & LINTER          ");
  console.log("=======================================================");
  console.log(`Generated:    ${report.generated_at}`);
  console.log(`Total Issues: ${report.total_issues}\n`);

  console.log("Issue Summary by Category:");
  console.log(`  • Broken Heading Anchors:      ${report.summary.broken_anchors}`);
  console.log(`  • Oversized Base64 Blobs:      ${report.summary.base64_blobs}`);
  console.log(`  • Localized Slug Drift:        ${report.summary.slug_drift}`);
  console.log(`  • Unmapped Notion References:  ${report.summary.unmapped_references}`);
  console.log("-------------------------------------------------------");

  if (report.items.length === 0) {
    console.log("✅ No editorial issues detected! Content is in clean state.\n");
    return;
  }

  console.log("\nTop Actionable Items for Notion Editors:\n");

  // Show base64 blobs first (highest performance impact)
  const base64Items = report.items.filter((i) => i.category === "base64_blob");
  if (base64Items.length > 0) {
    console.log("🖼️  OVERSIZED BASE64 IMAGES (High Priority):");
    for (const item of base64Items) {
      console.log(`  - Page: "${item.page_title}" (${item.page_id})`);
      if (item.block_id) console.log(`    Block ID: ${item.block_id}`);
      console.log(`    Size:     ${item.details.size_kb} KB`);
      console.log(`    Action:   ${item.guidance}\n`);
    }
  }

  // Show broken anchors
  const anchorItems = report.items.filter((i) => i.category === "broken_anchor");
  if (anchorItems.length > 0) {
    console.log("⚓ BROKEN HEADING ANCHORS:");
    for (const item of anchorItems.slice(0, 15)) {
      const aliasNote = item.details.healed_by_pipeline_alias
        ? " (Temporarily masked by pipeline alias)"
        : "";
      console.log(`  - From:   "${item.page_title}" (${item.locale})`);
      console.log(`    Target: /docs/${item.details.target_slug}#${item.details.anchor}${aliasNote}`);
      console.log(`    Action: ${item.guidance}\n`);
    }
    if (anchorItems.length > 15) {
      console.log(`    ... and ${anchorItems.length - 15} more broken anchors.`);
    }
  }

  // Show slug drift
  const slugItems = report.items.filter((i) => i.category === "slug_drift");
  if (slugItems.length > 0) {
    console.log("🔀 LOCALIZED SLUG DRIFT:");
    for (const item of slugItems.slice(0, 10)) {
      console.log(`  - In:       "${item.page_title}" (${item.locale})`);
      console.log(`    Used:     "${item.details.used_slug}"`);
      console.log(`    Expected: "/docs/${item.details.canonical_slug}"\n`);
    }
    if (slugItems.length > 10) {
      console.log(`    ... and ${slugItems.length - 10} more localized slug drift occurrences.`);
    }
  }

  console.log("=======================================================\n");
}

/**
 * CLI command runner for validate:editorial.
 */
export async function cmdValidateEditorial(
  args: Record<string, string>
): Promise<EditorialDiagnosticsReport> {
  const outputDir = args.out || path.resolve(process.cwd(), "output");
  const reportPath = path.join(outputDir, "editorial-diagnostics.json");

  console.log(`🔍 Scanning output directory "${outputDir}" for editorial diagnostics...`);
  const pages = loadPagesFromOutput(outputDir);

  if (pages.length === 0) {
    console.log("⚠️  No pages found in output directory. Run `pipeline sync:full` first.");
    const emptyReport: EditorialDiagnosticsReport = {
      generated_at: new Date().toISOString(),
      total_issues: 0,
      summary: {
        broken_anchors: 0,
        base64_blobs: 0,
        slug_drift: 0,
        unmapped_references: 0,
      },
      items: [],
    };
    return emptyReport;
  }

  console.log(`📄 Analyzing ${pages.length} document(s)...`);
  const report = runEditorialLinter(pages);

  // Validate output against schema
  EditorialDiagnosticsReportSchema.parse(report);

  // Ensure output dir exists and write json
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`💾 Saved report to: ${reportPath}`);

  if (!args["json-only"]) {
    printReportSummary(report);
  }

  return report;
}
