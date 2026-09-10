import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const GlossaryTermSchema = z.object({
  en: z.string(),
  pt: z.string(),
  es: z.string(),
  context: z.string().optional(),
});

export const GlossarySchema = z.object({
  version: z.string().optional(),
  updated_at: z.string().optional(),
  terms: z.array(GlossaryTermSchema),
});

export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;
export type Glossary = z.infer<typeof GlossarySchema>;

/**
 * Loads and validates glossary from file.
 * Defaults to config/glossary.json relative to cwd.
 */
export function loadGlossary(customPath?: string): Glossary {
  const filePath = customPath || join(process.cwd(), "config/glossary.json");
  if (!existsSync(filePath)) {
    throw new Error(`Glossary file not found: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return GlossarySchema.parse(raw);
}

/**
 * Formats a glossary into a markdown table prompt for the target locale.
 */
export function formatGlossaryPrompt(glossary: Glossary, locale: "pt" | "es"): string {
  const targetHeader = locale === "pt" ? "Portuguese" : "Spanish";
  const lines: string[] = [
    `| English | ${targetHeader} | Context |`,
    "|---|---|---|",
  ];

  for (const term of glossary.terms) {
    const targetVal = locale === "pt" ? term.pt : term.es;
    const ctx = term.context ? term.context.replace(/\|/g, "\\|") : "";
    lines.push(`| ${term.en} | ${targetVal} | ${ctx} |`);
  }

  return lines.join("\n");
}

/**
 * Case-insensitive lookup for a term translation.
 */
export function lookupTerm(glossary: Glossary, enTerm: string, locale: "pt" | "es"): string | null {
  const lower = enTerm.trim().toLowerCase();
  const found = glossary.terms.find((t) => t.en.toLowerCase() === lower);
  if (!found) return null;
  return locale === "pt" ? found.pt : found.es;
}
