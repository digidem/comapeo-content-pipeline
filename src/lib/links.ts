/**
 * Internal link & anchor resolution for the docs:pull pass.
 *
 * Notion authors cross-references against clean, often *localized* slugs
 * (e.g. `/docs/invita-colaboradores`) and original-cased heading anchors
 * (e.g. `#Edit-an-observation`). Docusaurus, however, publishes every
 * translation under the English source's slug (es/pt are served at
 * `/es/docs/<en-slug>` via i18n fallback), and generates heading IDs in
 * lowercase-hyphenated form.
 *
 * This module rewrites internal links to the actual published route for the
 * file's locale and slugifies `#anchor` fragments to the Docusaurus heading-ID
 * format, leaving genuinely-unknown targets untouched.
 *
 * Runtime-agnostic (no Node APIs).
 */

import GithubSlugger from "github-slugger";
import { slugify } from "./slug.js";

/**
 * Slugify a heading anchor to the Docusaurus heading-ID format.
 *
 * Docusaurus generates heading IDs with github-slugger, so we use the same
 * library to maximize matches (it keeps Unicode letters/accents and, notably,
 * does NOT collapse repeated separators — e.g. `A & B` → `a--b` — so we must
 * not collapse either). A fresh slugger per call avoids the dedup counter.
 */
export function slugifyAnchor(anchor: string): string {
  return new GithubSlugger().slug(anchor.trim());
}

/** Minimal doc shape needed to build the route maps. */
export interface DocLite {
  page_id: string;
  slug: string;
  title?: string;
}

export interface RouteMaps {
  /** slugify(any-known-slug) → canonical published English slug */
  slugMap: Map<string, string>;
  /** dashless page id → canonical published English slug */
  pageIdMap: Map<string, string>;
}

/**
 * Build lookup maps from every reference key an author might use (own slug,
 * title-derived slug, page id) to the canonical published English slug.
 *
 * `canonicalSlugOf` returns the slug a given page is actually published at —
 * for grouped pages this is the (cleaned) English source slug shared by all
 * translations.
 */
export function buildRouteMaps(
  docs: DocLite[],
  canonicalSlugOf: (pageId: string) => string | null,
): RouteMaps {
  const slugMap = new Map<string, string>();
  const pageIdMap = new Map<string, string>();

  // Pass 1: own slug (most reliable — links reference the target's own slug).
  for (const d of docs) {
    const canon = canonicalSlugOf(d.page_id);
    if (!canon) continue;
    pageIdMap.set(d.page_id.replace(/-/g, ""), canon);
    const key = slugify(d.slug);
    if (key && !slugMap.has(key)) slugMap.set(key, canon);
  }

  // Pass 2: title-derived slug (covers clean English references), without
  // overwriting an existing slug-based mapping.
  for (const d of docs) {
    if (!d.title) continue;
    const canon = canonicalSlugOf(d.page_id);
    if (!canon) continue;
    const key = slugify(d.title);
    if (key && !slugMap.has(key)) slugMap.set(key, canon);
  }

  // Pass 3: canonical slug itself (resolves links already written with the
  // canonical route). Without overwriting existing more-specific mappings.
  for (const d of docs) {
    const canon = canonicalSlugOf(d.page_id);
    if (!canon) continue;
    const key = slugify(canon);
    if (key && !slugMap.has(key)) slugMap.set(key, canon);
  }

  return { slugMap, pageIdMap };
}

function localePrefix(locale: string): string {
  if (locale === "es") return "/es";
  if (locale === "pt") return "/pt";
  return "";
}

/** Known slug aliases mapping historical/localized/stale slugs to canonical English slugs. */
export const KNOWN_SLUG_ALIASES: Record<string, string> = {
  // Exchange
  "entiende-como-funciona-el-intercambio": "understanding-how-exchange-works",
  "entendiendo-como-funciona-el-intercambio": "understanding-how-exchange-works",
  "conoce-como-funciona-el-intercambio": "understanding-how-exchange-works",
  "using-exchange-offline-2b61b081": "using-exchange-offline",
  "intercambia-datos-sin-conexion": "using-exchange-offline",
  "using-a-remote-archive": "using-exchange-over-the-internet-with-remote-archive",
  "usa-un-archivo-remoto": "using-exchange-over-the-internet-with-remote-archive",
  "usando-un-archivo-remoto": "using-exchange-over-the-internet-with-remote-archive",
  "usando-un-archivo-remoto-por-internet": "using-exchange-over-the-internet-with-remote-archive",
  "prepara-un-archivo-remoto": "using-exchange-over-the-internet-with-remote-archive",
  "using-exchange-over-the-internet": "using-exchange-over-the-internet",

  // Device Roles & Teams
  "seleccion-de-roles-y-equipos-de-dispositivos": "selecting-device-roles-and-teams",
  "seleccion-de-roles-de-dispositivo-y-equipos": "selecting-device-roles-and-teams",
  "seleccion-de-roles-y-equipos-del-dispositivo": "selecting-device-roles-and-teams",
  "selecting-device-roles-teams": "selecting-device-roles-and-teams",
  "selecting-device-roles-teams-es": "selecting-device-roles-and-teams",
  "gestionando-un-equipo": "managing-a-team",

  // Projects
  "comprende-las-bases-sobre-proyectos": "understanding-projects",
  "entendiendo-proyectos": "understanding-projects",
  "planificacion-y-preparacion-para-un-proyecto": "planning-and-preparing-for-a-project",
  "planning-preparing-for-a-project": "planning-and-preparing-for-a-project",
  "creando-un-nuevo-proyecto": "creating-a-new-project",
  "creating-a-new-project-2331b081": "creating-a-new-project",
  "creating-a-new-project-es": "creating-a-new-project",
  "dejar-un-proyecto": "leave-a-project",
  "leave-a-project-3221b081": "leave-a-project",
  "leave-a-project-es": "leave-a-project",
  "remocion-de-un-dispositivo-de-un-proyecto": "removing-a-device-from-a-project",
  "removing-a-device-from-a-project-3221b081": "removing-a-device-from-a-project",
  "removing-a-device-from-a-project-es": "removing-a-device-from-a-project",
  "ending-a-project-2331b081": "ending-a-project",
  "ending-a-project-es": "ending-a-project",
  "invitacion-de-colaboradores": "inviting-collaborators",
  "invita-colaboradores": "inviting-collaborators",
  "convidar-colaboradores": "inviting-collaborators",
  "organizing-key-materials-for-projects": "organizing-key-materials-for-a-project",

  // Categories
  "cambia-el-conjunto-de-categorías": "changing-categories-set",
  "cambiando-el-conjunto-de-categorias": "changing-categories-set",
  "changing-category-set": "changing-categories-set",
  "building-a-custom-categories-set": "creating-a-custom-categories-set",
  "creando-un-conjunto-de-categorias-personalizado": "creating-a-custom-categories-set",
  "crea-un-conjunto-de-categorías-personalizadas": "creating-a-custom-categories-set",
  "criar-um-conjunto-de-categorias-personalizado": "creating-a-custom-categories-set",
  "included-categories-set": "comapeo-categories",
  "categorias-de-comapeo": "comapeo-categories",

  // Observations & Tracks
  "edita-observaciones": "editing-observations-and-tracks",
  "editing-observations": "editing-observations-and-tracks",
  "editing-observation": "editing-observations-and-tracks",
  "editando-observacoes": "editing-observations-and-tracks",
  "edicion-de-observaciones-y-tracks": "editing-observations-and-tracks",
  "revisa-una-sola-observacion-y-trayecto": "reviewing-individual-observations-and-tracks",
  "reviewing-an-observation": "reviewing-individual-observations-and-tracks",
  "revisa-una-observacion": "reviewing-individual-observations-and-tracks",
  "revisando-uma-observação": "reviewing-individual-observations-and-tracks",
  "revision-de-observaciones-y-tracks-individuales": "reviewing-individual-observations-and-tracks",
  "borrando-observaciones-y-trayectos": "deleting-observations-and-tracks",
  "eliminacion-de-observaciones-y-tracks": "deleting-observations-and-tracks",
  "creando-una-nueva-observacion": "creating-a-new-observation",
  "crea-una-nueva-observacion": "creating-a-new-observation",
  "crear-uma-nova-observacao": "creating-a-new-observation",
  "creando-un-nuevo-track": "creating-a-new-track",
  "tracar-observacao": "creating-a-new-track",
  "exportando-todas-las-observaciones": "exporting-all-observations",

  // Background Maps
  "sharing-background-maps": "sharing-background-map",
  "compartiendo-mapas-de-fondo": "sharing-background-map",
  "creando-mapas-de-fondo-personalizados": "creating-custom-background-maps",

  // Onboarding & Security
  "understanding-comapeos-core-concepts-and-functions": "understanding-comapeo-s-core-concepts-and-functions",
  "instalacion-de-comapeo-e-induccion": "installing-comapeo-and-onboarding",
  "instalacion-de-comapeo-y-onboarding": "installing-comapeo-and-onboarding",
  "installing-comapeo--onboarding": "installing-comapeo-and-onboarding",
  "uso-inicial-y-ajustes-de-comapeo": "getting-familiar-with-comapeo",
  "initial-use-and-comapeo-settings": "getting-familiar-with-comapeo",
  "usa-una-contraseña-para-comapeo-por-seguridad": "using-an-app-passcode-for-security",
  "desinstala-comapeo": "uninstalling-comapeo",

  // Troubleshooting
  "solucion-de-problemas-observaciones-y-tracks": "troubleshooting-observations-and-tracks",
  "solucao-de-problemas-observacoes-e-trilhas": "troubleshooting-observations-and-tracks",
};

/** Cross-language anchor aliases scoped by target doc and locale. */
export const KNOWN_DOC_ANCHOR_ALIASES: Record<string, Record<string, Record<string, string>>> = {
  "troubleshooting-mapping-with-collaborators": {
    es: {
      "exchange-problems": "problemas-de-intercambio",
      "project-setting-problems": "problemas-de-configuración-del-proyecto",
    },
    pt: {
      "exchange-problems": "problemas-de-troca",
      "project-setting-problems": "problemas-de-configuração-do-projeto",
    },
  },
  "common-solutions": {
    es: {
      "solution-check-app-permissions": "solución-verificar-los-permisos-de-la-aplicación",
      "solution-make-sure-your-device-has-enough-free-space-available": "solución-asegúrate-de-que-tu-dispositivo-tenga-suficiente-espacio-libre-disponible",
      "solution-check-that-every-device-is-actually-connected-to-the-wifi-network": "solución-verifica-que-cada-dispositivo-esté-realmente-conectado-a-la-red-wifi",
      "solution-check-that-every-device-is-on-the-same-wifi-network": "solución-verifica-que-todos-los-dispositivos-estén-en-la-misma-red-wifi",
      "solution-reduce-the-number-of-devices-connected-to-wifi-at-the-same-time": "solución-reduce-la-cantidad-de-dispositivos-conectados-al-wifi-al-mismo-tiempo",
      "solution-close--restart-comapeo": "solución-cerrar-y-reiniciar-comapeo",
    },
    pt: {
      "solution-check-app-permissions": "solução-verificar-permissões-do-aplicativo",
      "solution-make-sure-your-device-has-enough-free-space-available": "solução-certifique-se-de-que-seu-dispositivo-tenha-espaço-livre-suficiente-disponível",
      "solution-check-that-every-device-is-actually-connected-to-the-wifi-network": "solução-verifique-se-todos-os-dispositivos-estão-realmente-conectados-à-rede-wifi",
      "solution-check-that-every-device-is-on-the-same-wifi-network": "solução-verifique-se-todos-os-dispositivos-estão-na-mesma-rede-wifi",
      "solution-reduce-the-number-of-devices-connected-to-wifi-at-the-same-time": "solução-reduza-o-número-de-dispositivos-conectados-ao-wifi-ao-mesmo-tempo",
      "solution-close--restart-comapeo": "solução-fechar--reiniciar-comapeo",
    },
  },
  "selecting-device-roles-and-teams": {
    es: {
      "roles-available-in-comapeo": "roles-disponibles-en-comapeo",
    },
    pt: {
      "roles-available-in-comapeo": "funções-disponíveis-no-comapeo",
    },
  },
  "understanding-how-exchange-works": {
    es: {
      "what-if-there-is-a-data-conflict": "qué-pasa-si-hay-un-conflicto-de-datos",
      "adjusting-exchange-settings": "ajustando-la-configuración-de-intercambio",
      "configuracion-de-intercambio": "ajustando-la-configuración-de-intercambio",
    },
    pt: {
      "what-if-there-is-a-data-conflict": "o-que-acontece-se-houver-um-conflito-de-dados",
      "adjusting-exchange-settings": "ajustando-as-configurações-de-troca",
    },
  },
  "troubleshooting-setup-and-customization": {
    es: {
      "custom-category-set-problems": "problemas-del-conjunto-de-categorías-personalizado",
    },
    pt: {
      "custom-category-set-problems": "problemas-com-o-conjunto-de-categorias-personalizadas",
    },
  },
  "creating-a-new-observation": {
    es: {
      "adding-photos": "agregar-fotos",
    },
    pt: {
      "adding-photos": "adicionar-fotos",
    },
  },
  "deleting-observations-and-tracks": {
    es: {
      "deleting-media": "eliminación-de-medios",
    },
    pt: {
      "deleting-media": "exclusão-de-mídia",
    },
  },
};

/** Category route aliases mapping localized/historical category names to canonical category directory keys. */
export const KNOWN_CATEGORY_ALIASES: Record<string, string> = {
  "solucion-de-problemas": "miscellaneous",
  "solucao-de-problemas": "miscellaneous",
  "troubleshooting": "miscellaneous",
  "introduccion---conceptos-basicos": "getting-started-essentials",
  "introducao---nocoes-basicas": "getting-started-essentials",
  "getting-started---essentials": "getting-started-essentials",
  "personaliza-comapeo": "preparing-to-use-comapeo",
  "personalizando-comapeo": "preparing-to-use-comapeo",
  "customizing-comapeo": "preparing-to-use-comapeo",
  "recopila-observaciones-y-trayectos": "gathering-observations-and-tracks",
  "registra-observaciones-y-trayectos": "gathering-observations-and-tracks",
  "coletando-observacoes-e-trilhas": "gathering-observations-and-tracks",
  "gathering-observations-and-tracks": "gathering-observations-and-tracks",
  "gathering-observations--tracks": "gathering-observations-and-tracks",
  "revisa-observaciones": "reviewing-observations-and-tracks",
  "revisando-observacoes": "reviewing-observations-and-tracks",
  "reviewing-observations": "reviewing-observations-and-tracks",
  "gestion-de-privacidad-y-seguridad-de-datos": "managing-data-and-privacy",
  "gestao-de-privacidade-de-dados-e-seguranca": "managing-data-and-privacy",
  "managing-data-privacy--security": "managing-data-and-privacy",
  "managing-data-privacy-and-security": "managing-data-and-privacy",
  "gestion-de-proyectos": "managing-projects",
  "gestao-de-projetos": "managing-projects",
  "managing-projects": "managing-projects",
  "intercambia-observaciones": "exchanging-observations",
  "intercambiando-observaciones": "exchanging-observations",
  "exchanging-observations": "exchanging-observations",
};

function resolveFromText(text: string, maps: RouteMaps): string | null {
  const cleaned = text
    .replace(/(?:🔗|✔️|👉🏽|👉🏾|👉|💡|⚠️|📄)/gu, "")
    .replace(/\b(go to|ir a|acesse|veja|ver|see|para)\b/gi, "")
    .replace(/[*_`]/g, "")
    .trim();
  const slug = slugify(cleaned);
  if (!slug) return null;
  const alias = KNOWN_SLUG_ALIASES[slug];
  if (alias) return alias;
  return maps.slugMap.get(slug) ?? null;
}

/**
 * Resolve a single internal link target to its published route, or return
 * `null` to leave it unchanged (external link or unknown target).
 */
function resolveTarget(
  target: string,
  prefix: string,
  maps: RouteMaps,
  locale?: string,
  text?: string,
): string | null {
  let t = target.trim();

  // Same-page anchor — just slugify the fragment.
  if (t.startsWith("#")) {
    const a = slugifyAnchor(t.slice(1));
    return a ? `#${a}` : null;
  }

  // Strip a Notion host so notion.so/docs/... and notion.so/<id> normalize to
  // an internal path.
  t = t.replace(/^https?:\/\/(?:www\.)?notion\.so/i, "");

  // Normalize missing leading slash or singular /doc/ prefix
  t = t.replace(/^\/?docs?\//i, "/docs/");
  t = t.replace(/^\/?category\//i, "/category/");

  // Only internal absolute paths are candidates.
  if (!t.startsWith("/")) return null;

  // Split off the anchor.
  const hashIdx = t.indexOf("#");
  const rawAnchor = hashIdx === -1 ? "" : t.slice(hashIdx + 1);
  let path = hashIdx === -1 ? t : t.slice(0, hashIdx);

  // Drop trailing slashes and any existing locale prefix.
  path = path.replace(/\/+$/, "");
  path = path.replace(/^\/(?:es|pt)(?=\/)/i, "");

  // Category index link resolution (/category/<slug> or /docs/category/<slug>)
  const catMatch = path.match(/^\/?(?:docs\/)?category\/(.+)$/i);
  if (catMatch) {
    let catSeg = catMatch[1];
    try {
      catSeg = decodeURIComponent(catSeg);
    } catch {
      /* leave catSeg as-is */
    }
    const catSlug = slugify(catSeg);
    const canonCat = KNOWN_CATEGORY_ALIASES[catSlug] ?? catSlug;
    return `${prefix}/docs/category/${canonCat}`;
  }

  let canon: string | null = null;

  const docsMatch = path.match(/^\/docs?\/(.+)$/i);
  if (docsMatch) {
    // Last path segment is the slug (routes are flat: /docs/<slug>).
    const segs = docsMatch[1].split("/");
    let seg = segs[segs.length - 1] || docsMatch[1];
    try {
      seg = decodeURIComponent(seg);
    } catch {
      /* leave seg as-is on malformed escapes */
    }
    let key = slugify(seg);
    if (KNOWN_SLUG_ALIASES[key]) {
      key = KNOWN_SLUG_ALIASES[key];
    }
    canon = maps.slugMap.get(key) ?? (maps.slugMap.has(slugify(key)) ? maps.slugMap.get(slugify(key))! : null);
    if (!canon && KNOWN_SLUG_ALIASES[key]) {
      canon = KNOWN_SLUG_ALIASES[key];
    }
  } else {
    const hexMatch = path.match(/^\/([0-9a-fA-F]{32})/);
    if (hexMatch) {
      canon = maps.pageIdMap.get(hexMatch[1].toLowerCase()) ?? null;
    }
  }

  // Fallback: If target could not be resolved directly, attempt inference from link label
  if (!canon && text) {
    canon = resolveFromText(text, maps);
  }

  if (!canon) return null; // genuinely unknown — leave the original link

  let anchor = "";
  if (rawAnchor) {
    let a = slugifyAnchor(rawAnchor);
    if (locale && canon && KNOWN_DOC_ANCHOR_ALIASES[canon]?.[locale]?.[a]) {
      a = KNOWN_DOC_ANCHOR_ALIASES[canon][locale][a];
    }
    anchor = `#${a}`;
  }
  return `${prefix}/docs/${canon}${anchor}`;
}

/**
 * Rewrite internal Markdown links in `content` for a file of the given locale.
 * Images (`![alt](…)`) and external/unknown links are left untouched.
 */
export function resolveInternalLinks(
  content: string,
  opts: { locale: string; maps: RouteMaps },
): string {
  // Pre-process nested markdown links pasted inside target:
  // e.g. [Text]([Text](/docs/a)%20%20/docs/b) -> [Text](/docs/b)
  content = content.replace(
    /\[([^\]]+)\]\(\[[^\]]+\]\([^)]+\)[^/]*(\/?docs?\/[^)]+)\)/gi,
    "[$1]($2)",
  );

  const prefix = localePrefix(opts.locale);
  return content.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (match, bang: string, text: string, target: string) => {
      if (bang) return match; // image, not a link
      const resolved = resolveTarget(target, prefix, opts.maps, opts.locale, text);
      return resolved === null ? match : `[${text}](${resolved})`;
    },
  );
}
