import { describe, it, expect } from "vitest";
import { GlossarySchema, loadGlossary, formatGlossaryPrompt, lookupTerm } from "./glossary.js";

describe("Glossary", () => {
  const sampleGlossary = {
    version: "1.0.0",
    terms: [
      { en: "Observation", pt: "Observação", es: "Observación", context: "Core entity" },
      { en: "Track", pt: "Trajeto", es: "Trayecto" },
    ],
  };

  it("validates valid glossary schema", () => {
    const parsed = GlossarySchema.parse(sampleGlossary);
    expect(parsed.terms).toHaveLength(2);
    expect(parsed.terms[0].en).toBe("Observation");
  });

  it("formats glossary prompt for Portuguese", () => {
    const prompt = formatGlossaryPrompt(sampleGlossary, "pt");
    expect(prompt).toContain("| English | Portuguese | Context |");
    expect(prompt).toContain("| Observation | Observação | Core entity |");
    expect(prompt).toContain("| Track | Trajeto |");
    expect(prompt).not.toContain("Trayecto");
  });

  it("formats glossary prompt for Spanish", () => {
    const prompt = formatGlossaryPrompt(sampleGlossary, "es");
    expect(prompt).toContain("| English | Spanish | Context |");
    expect(prompt).toContain("| Observation | Observación | Core entity |");
    expect(prompt).toContain("| Track | Trayecto |");
    expect(prompt).not.toContain("Observação");
  });

  it("looks up terms case-insensitively", () => {
    expect(lookupTerm(sampleGlossary, "observation", "pt")).toBe("Observação");
    expect(lookupTerm(sampleGlossary, "TRACK", "es")).toBe("Trayecto");
    expect(lookupTerm(sampleGlossary, "nonexistent", "pt")).toBeNull();
  });

  it("loads config/glossary.json successfully", () => {
    const loaded = loadGlossary();
    expect(loaded.terms.length).toBeGreaterThan(5);
    expect(lookupTerm(loaded, "Exchange", "pt")).toBe("Troca");
    expect(lookupTerm(loaded, "Exchange", "es")).toBe("Intercambio");
  });
});
