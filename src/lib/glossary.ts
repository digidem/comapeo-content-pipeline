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

export const DEFAULT_GLOSSARY: Glossary = {
  version: "1.0.0",
  updated_at: "2026-09-09",
  terms: [
    { en: "Observation", pt: "Observação", es: "Observación", context: "Core CoMapeo record entity" },
    { en: "Observations", pt: "Observações", es: "Observaciones", context: "Plural of Observation" },
    { en: "Track", pt: "Trajeto", es: "Trayecto", context: "Recorded GPS track / route" },
    { en: "Tracks", pt: "Trajetos", es: "Trayectos", context: "Plural of Track" },
    { en: "Exchange", pt: "Troca", es: "Intercambio", context: "Peer-to-peer data sync between devices" },
    { en: "Peer-to-peer", pt: "Ponto a ponto", es: "Punto a punto", context: "Direct device communication" },
    { en: "Background Map", pt: "Mapa de fundo", es: "Mapa de fondo", context: "Offline map layer or raster tile pack" },
    { en: "Background Maps", pt: "Mapas de fundo", es: "Mapas de fondo", context: "Plural of Background Map" },
    { en: "Device Role", pt: "Função do dispositivo", es: "Rol del dispositivo", context: "Participant permission level on a project" },
    { en: "Device Roles", pt: "Funções do dispositivo", es: "Roles de dispositivos", context: "Plural of Device Role" },
    { en: "Team", pt: "Equipe", es: "Equipo", context: "Group of collaborators in a project" },
    { en: "Teams", pt: "Equipes", es: "Equipos", context: "Plural of Team" },
    { en: "Project", pt: "Projeto", es: "Proyecto", context: "CoMapeo collaboration container" },
    { en: "Projects", pt: "Projetos", es: "Proyectos", context: "Plural of Project" },
    { en: "Category", pt: "Categoria", es: "Categoría", context: "Observation preset taxonomy" },
    { en: "Categories", pt: "Categorias", es: "Categorías", context: "Plural of Category" },
    { en: "Passcode", pt: "Código de acesso", es: "Código de acceso", context: "Security PIN / password for app access" },
    { en: "Sync", pt: "Sincronização", es: "Sincronización", context: "Data synchronization" },
  ],
};

/**
 * Loads and validates glossary.
 * If raw is provided (object or JSON string), validates and returns it.
 * Otherwise returns DEFAULT_GLOSSARY.
 */
export function loadGlossary(raw?: unknown): Glossary {
  if (!raw) return DEFAULT_GLOSSARY;
  if (typeof raw === "string") {
    return GlossarySchema.parse(JSON.parse(raw));
  }
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
