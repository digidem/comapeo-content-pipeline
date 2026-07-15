/**
 * Canonical hierarchy model shared by docs:pull, manifest generation, and Worker.
 * Runtime-agnostic. All external data via metadata-filled maps.
 */

import type { ManifestDoc } from "../schemas/manifest.js";
import {
  normalizeLocale, isContentPage, isStructuralPage,
  NOTION_ELEMENT_TYPES, SECTION_NAMES, UNCATEGORIZED_ORDER,
  stripSectionPrefix, CURATED_SECTION_TRANSLATIONS, manifestElementType,
} from "./notion-properties.js";
import { slugify } from "./slug.js";

// ── Types ──

export interface CanonicalPage {
  pageId: string; doc: ManifestDoc; canonicalSlug: string;
  canonicalSection: string; canonicalOrder: number; locale: string;
  elementType: string; title: string; isStructural: boolean;
  parentId?: string; customPropsTitle?: string; toggleDir?: string;
  enFallbackPageId?: string;
  /** Sort order for event replay (selected EN child order, or canonicalOrder). */
  eventOrder: number;
  /** Resolved body availability (from preflight or FamilyMember). */
  hasBody: boolean;
  /** Resolved language source (from preflight or FamilyMember). */
  languageSource: "explicit" | "automated" | "fallback";
}

export interface CategoryEntry {
  sectionDir: string; toggleDir?: string; locale: string;
  label: string; position: number; customPropsTitle?: string;
  /**
   * Stable, locale-independent unique key for Docusaurus sidebar translation.
   * Section-level: `sectionDir`; toggle-level: `sectionDir/toggleDir`.
   * Prevents duplicate i18n translation keys when parent and child categories
   * share the same localized label (e.g. "Gathering Observations & Tracks").
   */
  key: string;
}

export interface CanonicalRouteAlias { canonicalSlug: string; aliasKey: string; pageId: string; }

export interface HierarchyPlan {
  canonicalPages: CanonicalPage[]; categories: CategoryEntry[];
  diagnostics: ValidationIssue[]; routeAliases: CanonicalRouteAlias[];
}

export interface ValidationIssue { severity: "warn" | "error"; category: string; pageId: string; title: string; detail: string; }

export interface BuildInput {
  docs: ManifestDoc[]; includeDrafts: boolean;
  languageSourceById?: Record<string, "explicit" | "automated" | "fallback">;
  hasBodyById?: Record<string, boolean>;
}

// ── Family member ──

interface FamilyMember {
  doc: ManifestDoc; locale: string; elementType: string;
  section: string | null; order: number | null;
  languageSource: "explicit" | "automated" | "fallback"; hasBody: boolean;
  isRelationChild: boolean;
}

interface ResolvedFamily {
  parentDoc: ManifestDoc; parentLocale: string;
  selected: Map<string, FamilyMember>;
  canonicalSection: string; canonicalOrder: number; canonicalSlug: string;
  isContent: boolean; flowOrder: number;
}

// ── Detection ──

const TEST_PAGE_TITLE = /^\s*[[(]?\s*(testing|test|teste|prueba)\b/i;
const INTERNAL_PAGE_TITLE = /^\s*(new element|process checklist)\s*$/i;
const INTERNAL_PAGE_MARKER = /\[\s*(add content here|en title|insert content here)\s*\]/i;
const INTERNAL_PAGE_ANNOTATION = /\((?:translating|translation|for translation|staging|do not publish|internal)[^)]*\)/i;
const STAGING_SUFFIX = /[-_]\d{4}-\d{2}-\d{2}\s*translation/i;

function isInternalTitle(title: string, pageId: string): boolean {
  return INTERNAL_PAGE_TITLE.test(title) || INTERNAL_PAGE_MARKER.test(title) ||
    INTERNAL_PAGE_ANNOTATION.test(title) || title.trim() === pageId;
}

function getLanguageSource(doc: ManifestDoc, map?: Record<string, "explicit" | "automated" | "fallback">): "explicit" | "automated" | "fallback" {
  if (map && doc.page_id in map) return map[doc.page_id];
  if (doc.language_source) return doc.language_source;
  return "fallback";
}

// ── Select locale representative ──

function selectLocaleMember(members: FamilyMember[], locale: string): FamilyMember | undefined {
  const filtered = members.filter((m) => m.locale === locale);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];

  // Prefer relation children over parent
  const children = filtered.filter((m) => m.isRelationChild);
  const candidates = children.length > 0 ? children : filtered;

  if (candidates.length === 1) return candidates[0];

  // Has usable body beats stub/missing
  const withBody = candidates.filter((m) => m.hasBody);
  const usableCandidates = withBody.length > 0 ? withBody : candidates;

  // Rank: explicit > automated > fallback, typed > untyped, non-staging > staging, lower order
  const srcRank: Record<string, number> = { explicit: 0, automated: 1, fallback: 2 };
  usableCandidates.sort((a, b) => {
    const sa = srcRank[a.languageSource] ?? 3;
    const sb = srcRank[b.languageSource] ?? 3;
    if (sa !== sb) return sa - sb;
    const at = manifestElementType(a.doc) !== "" ? 0 : 1;
    const bt = manifestElementType(b.doc) !== "" ? 0 : 1;
    if (at !== bt) return at - bt;
    const as = STAGING_SUFFIX.test(a.doc.title ?? "") ? 1 : 0;
    const bs = STAGING_SUFFIX.test(b.doc.title ?? "") ? 1 : 0;
    if (as !== bs) return as - bs;
    const ao = a.order ?? 99999;
    const bo = b.order ?? 99999;
    return ao - bo;
  });
  return usableCandidates[0];
}

// ── Main ──

export function buildHierarchyPlan(input: BuildInput): HierarchyPlan {
  const { docs, includeDrafts, languageSourceById, hasBodyById } = input;
  const docById = new Map<string, ManifestDoc>();
  for (const doc of docs) docById.set(doc.page_id, doc);

  const diagnostics: ValidationIssue[] = [];
  const claimedIds = new Set<string>();
  const internalGroupIds = new Set<string>();

  for (const doc of docs) {
    if (!isInternalTitle(doc.title ?? "", doc.page_id)) continue;
    internalGroupIds.add(doc.page_id);
    if (doc.sub_items) for (const sid of doc.sub_items) internalGroupIds.add(sid);
  }

  // ── Claim all parent + sub_item IDs before any gate ──
  // Also track which page_ids appear as *someone else's* sub_item, so a page
  // that is both a translation child and (erroneously) carries its own
  // sub_items doesn't form a second, independent family — that would publish
  // it twice under two different canonical slugs (once as a family member,
  // once as its own family's root).
  const subItemIds = new Set<string>();
  for (const doc of docs) {
    if (!doc.sub_items || doc.sub_items.length === 0) continue;
    if (internalGroupIds.has(doc.page_id)) continue;
    claimedIds.add(doc.page_id);
    for (const sid of doc.sub_items) {
      claimedIds.add(sid);
      if (sid !== doc.page_id) subItemIds.add(sid);
    }
  }

  const families: ResolvedFamily[] = [];

  for (const doc of docs) {
    if (!doc.sub_items || doc.sub_items.length === 0) continue;
    if (internalGroupIds.has(doc.page_id)) continue;
    if (subItemIds.has(doc.page_id)) {
      diagnostics.push({
        severity: "warn", category: "nested-family-skipped", pageId: doc.page_id, title: doc.title ?? "",
        detail: "Page is itself a Sub-item of another family and also carries its own sub_items; skipping the nested family to avoid publishing it twice under two different slugs.",
      });
      continue;
    }

    const parentLocale = normalizeLocale(doc.locale);
    const isContent = isContentPage(manifestElementType(doc));
    const isStructural = isStructuralPage(manifestElementType(doc));
    if (!isContent && !isStructural) continue;

    // Parent must not be dead; content family also needs publishable gate
    if (doc.status === "deprecated" || doc.status === "archived") continue;
    if (isContent && !includeDrafts && doc.status !== "active") continue;
    // Structural families always processed if parent not dead (draft children supply labels)

    // Collect members in relation order: children first, parent last
    const allMembers: FamilyMember[] = [];
    for (const sid of doc.sub_items) {
      if (internalGroupIds.has(sid)) continue;
      const child = docById.get(sid);
      if (!child) continue;
      const cStatus = child.status;
      if (cStatus === "deprecated" || cStatus === "archived") continue;
      allMembers.push({
        doc: child, locale: normalizeLocale(child.locale),
        elementType: manifestElementType(child), section: child.section,
        order: child.section_order ?? null,
        languageSource: getLanguageSource(child, languageSourceById),
        hasBody: hasBodyById?.[sid] ?? false, isRelationChild: true,
      });
    }
    allMembers.push({
      doc, locale: parentLocale, elementType: manifestElementType(doc),
      section: doc.section, order: doc.section_order ?? null,
      languageSource: getLanguageSource(doc, languageSourceById),
      hasBody: hasBodyById?.[doc.page_id] ?? false, isRelationChild: false,
    });

    // Select representatives
    const selected = new Map<string, FamilyMember>();
    const locales = new Set(allMembers.map((m) => m.locale));
    for (const loc of locales) {
      const sel = selectLocaleMember(allMembers, loc);
      if (sel) selected.set(loc, sel);
    }

    // Selected EN relation child (not raw first EN child) for non-EN families
    const selectedEn = selected.get("en");
    const enChildren = allMembers.filter((m) => m.locale === "en" && m.isRelationChild);

    let canonicalSection: string;
    let canonicalOrder: number;
    let canonicalSlug: string;

    if (parentLocale === "en") {
      // EN parent: section fallback = parent.section ?? selected EN child's non-null section
      const enSelSection = selectedEn?.section;
      canonicalSection = doc.section || enSelSection || SECTION_NAMES.UNCATEGORIZED;
      canonicalOrder = doc.section_order ?? selectedEn?.order ?? UNCATEGORIZED_ORDER;
      canonicalSlug = slugify(doc.title ?? "") || doc.slug;
    } else {
      // Non-EN parent: derive from selected EN relation child
      const enRef = selectedEn ?? (enChildren.length > 0 ? enChildren[0] : undefined);
      canonicalSection = doc.section || enRef?.section || SECTION_NAMES.UNCATEGORIZED;
      canonicalOrder = doc.section_order ?? enRef?.order ?? UNCATEGORIZED_ORDER;
      canonicalSlug = enRef ? (slugify(enRef.doc.title ?? "") || enRef.doc.slug) : (slugify(doc.title ?? "") || doc.slug);
    }

    // Flow order for every family = selected EN child's order when available
    const flowOrder = selectedEn?.order ?? canonicalOrder;

    families.push({ parentDoc: doc, parentLocale, selected, canonicalSection, canonicalOrder, canonicalSlug, isContent, flowOrder });
  }

  // Add standalone structural rows as one-member families
  for (const doc of docs) {
    if (claimedIds.has(doc.page_id) || internalGroupIds.has(doc.page_id)) continue;
    const et = manifestElementType(doc);
    if (!isStructuralPage(et)) continue;
    const locale = normalizeLocale(doc.locale);
    families.push({
      parentDoc: doc, parentLocale: locale,
      selected: new Map([[locale, {
        doc, locale, elementType: et, section: doc.section, order: doc.section_order ?? null,
        languageSource: getLanguageSource(doc, languageSourceById),
        hasBody: hasBodyById?.[doc.page_id] ?? false, isRelationChild: false,
      }]]),
      canonicalSection: doc.section || SECTION_NAMES.UNCATEGORIZED,
      canonicalOrder: doc.section_order ?? UNCATEGORIZED_ORDER,
      canonicalSlug: slugify(doc.title ?? "") || doc.slug, isContent: false,
      flowOrder: doc.section_order ?? UNCATEGORIZED_ORDER,
    });
    claimedIds.add(doc.page_id);
  }

  // ── Content pages from families + standalone ──
  const canonicalPages: CanonicalPage[] = [];
  const routeAliases: CanonicalRouteAlias[] = [];

  for (const family of families) {
    if (!family.isContent) continue;

    for (const [locale, member] of family.selected) {
      if (!isContentPage(member.elementType)) continue;

      // Determine EN fallback for stubs
      let enFallbackPageId: string | undefined;
      if (locale !== "en" && !member.hasBody) {
        const enSel = family.selected.get("en");
        if (enSel && enSel.hasBody) enFallbackPageId = enSel.doc.page_id;
      }

      canonicalPages.push({
        pageId: member.doc.page_id, doc: member.doc,
        canonicalSlug: family.canonicalSlug,
        canonicalSection: family.canonicalSection || SECTION_NAMES.UNCATEGORIZED,
        canonicalOrder: family.canonicalOrder, locale,
        elementType: member.elementType, title: member.doc.title ?? "",
        isStructural: false, parentId: family.parentDoc.page_id,
        enFallbackPageId,
        eventOrder: family.flowOrder,
        hasBody: member.hasBody,
        languageSource: member.languageSource,
      });
    }

    // Route aliases
    for (const member of family.selected.values()) {
      for (const m of [family.parentDoc, ...family.parentDoc.sub_items?.map((sid) => docById.get(sid)).filter((d): d is ManifestDoc => d != null) ?? []]) {
        if (m.page_id === member.doc.page_id) continue;
        if (m.slug && m.slug !== family.canonicalSlug)
          routeAliases.push({ canonicalSlug: family.canonicalSlug, aliasKey: slugify(m.slug), pageId: m.page_id });
        const ts = slugify(m.title ?? "");
        if (ts && ts !== family.canonicalSlug && ts !== m.slug)
          routeAliases.push({ canonicalSlug: family.canonicalSlug, aliasKey: ts, pageId: m.page_id });
      }
      routeAliases.push({ canonicalSlug: family.canonicalSlug, aliasKey: member.doc.page_id.replace(/-/g, ""), pageId: member.doc.page_id });
    }
  }

  // Standalone content pages (not claimed by any family)
  for (const doc of docs) {
    if (claimedIds.has(doc.page_id) || internalGroupIds.has(doc.page_id)) continue;
    const et = manifestElementType(doc);
    if (!isContentPage(et)) continue;
    if (doc.status === "deprecated" || doc.status === "archived") continue;
    if (!includeDrafts && doc.status !== "active") continue;
    const title = doc.title ?? "";
    if (TEST_PAGE_TITLE.test(title) || isInternalTitle(title, doc.page_id)) continue;
    const locale = normalizeLocale(doc.locale);
    const cslug = doc.slug || slugify(title) || doc.page_id.slice(0, 8);
    canonicalPages.push({
      pageId: doc.page_id, doc, canonicalSlug: cslug,
      canonicalSection: doc.section || SECTION_NAMES.UNCATEGORIZED,
      canonicalOrder: doc.section_order ?? UNCATEGORIZED_ORDER,
      locale, elementType: et.toLowerCase(), title, isStructural: false,
      eventOrder: doc.section_order ?? UNCATEGORIZED_ORDER,
      hasBody: hasBodyById?.[doc.page_id] ?? false,
      languageSource: getLanguageSource(doc, languageSourceById),
    });
    routeAliases.push({ canonicalSlug: cslug, aliasKey: doc.page_id.replace(/-/g, ""), pageId: doc.page_id });
    if (doc.slug !== cslug) routeAliases.push({ canonicalSlug: cslug, aliasKey: slugify(doc.slug), pageId: doc.page_id });
  }

  // ── Event replay per section ──
  const structuralFamilies = families.filter((f) => !f.isContent);
  const categories: CategoryEntry[] = [];

  const structBySection = new Map<string, ResolvedFamily[]>();
  for (const f of structuralFamilies) {
    const list = structBySection.get(f.canonicalSection) ?? [];
    list.push(f);
    structBySection.set(f.canonicalSection, list);
  }
  for (const [, list] of structBySection) list.sort((a, b) => a.flowOrder - b.flowOrder);

  // Also gather content sections
  const contentBySection = new Map<string, CanonicalPage[]>();
  for (const cp of canonicalPages) {
    const list = contentBySection.get(cp.canonicalSection) ?? [];
    list.push(cp);
    contentBySection.set(cp.canonicalSection, list);
  }

  const allSections = new Set([...structBySection.keys(), ...contentBySection.keys()]);
  const sortedSections = [...allSections].sort((a, b) => sectionSortKey(a) - sectionSortKey(b));

  // Build docSourceIndex for stable tie breaking
  const docSourceIndex = new Map<string, number>();
  for (let i = 0; i < docs.length; i++) docSourceIndex.set(docs[i].page_id, i);

  let sectionPos = 1;

  for (const section of sortedSections) {
    const sectionDir = toSectionDir(section);
    const structs = structBySection.get(section) ?? [];
    const pages = contentBySection.get(section) ?? [];
    const sectionLocales = new Set<string>();
    for (const f of structs) for (const loc of f.selected.keys()) sectionLocales.add(loc);
    for (const cp of pages) sectionLocales.add(cp.locale);

    // Build events: structural events + page events, sorted by flow order / canonical order
    interface Event { type: "title" | "toggle" | "page"; family?: ResolvedFamily; page?: CanonicalPage; order: number; idx: number; }
    const events: Event[] = [];
    for (const f of structs) {
      const et = manifestElementType(f.parentDoc);
      const enRep = f.selected.get("en");
      const idx = enRep ? (docSourceIndex.get(enRep.doc.page_id) ?? docSourceIndex.get(f.parentDoc.page_id) ?? 0) : (docSourceIndex.get(f.parentDoc.page_id) ?? 0);
      if (et.toLowerCase() === NOTION_ELEMENT_TYPES.TITLE) events.push({ type: "title", family: f, order: f.flowOrder, idx });
      else if (et.toLowerCase() === NOTION_ELEMENT_TYPES.TOGGLE) events.push({ type: "toggle", family: f, order: f.flowOrder, idx });
    }
    for (const cp of pages) events.push({ type: "page", page: cp, order: cp.eventOrder, idx: docSourceIndex.get(cp.pageId) ?? 0 });
    events.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.idx - b.idx;
    });

    // Replay per locale
    for (const locale of sectionLocales) {
      let pendingHeading: string | undefined;
      let activeToggleDir: string | undefined;

      for (const ev of events) {
        if (ev.type === "title" && ev.family) {
          // A Title event always resets the pending heading for this locale —
          // even when the Title itself has no translated member here — so a
          // heading from an earlier, unrelated Title never bleeds into later
          // content once a new Title boundary has been crossed.
          const member = ev.family.selected.get(locale);
          pendingHeading = member ? (member.doc.title ?? "") : undefined;
          activeToggleDir = undefined;
        } else if (ev.type === "toggle" && ev.family) {
          const member = ev.family.selected.get(locale);
          const enParent = ev.family.parentLocale === "en" ? ev.family.parentDoc : undefined;
          const toggleDir = slugify(enParent?.title ?? ev.family.parentDoc.title ?? "") || `toggle-${ev.family.parentDoc.page_id.slice(0, 8)}`;
          // Consume the pending heading unconditionally: a Toggle boundary — translated
          // or not — must not let a stale heading leak into pages nested under it.
          const heading = pendingHeading;
          pendingHeading = undefined;
          let label: string;
          if (member) {
            const trunc = /(?:…|\.\.\.)$/.test((member.doc.title ?? "").trim());
            label = trunc
              ? (CURATED_SECTION_TRANSLATIONS[locale]?.[stripSectionPrefix(section)] ?? stripSectionPrefix(member.doc.title ?? ""))
              : (member.doc.title ?? "");
          } else {
            // No translated Toggle row for this locale, but content pages may still
            // land in this directory (e.g. via EN body fallback) — fall back to a
            // curated or stripped-English label instead of leaving the directory
            // without a localized category entry.
            const enTitle = enParent?.title ?? ev.family.parentDoc.title ?? "";
            label = CURATED_SECTION_TRANSLATIONS[locale]?.[stripSectionPrefix(enTitle)] ?? stripSectionPrefix(enTitle);
          }
          categories.push({ sectionDir, toggleDir, locale, label, position: ev.family.flowOrder, customPropsTitle: heading, key: `${sectionDir}/${toggleDir}` });
          activeToggleDir = toggleDir;
        } else if (ev.type === "page" && ev.page) {
          const cp = ev.page;
          if (cp.locale !== locale) continue;
          if (pendingHeading !== undefined) {
            cp.customPropsTitle = pendingHeading;
            pendingHeading = undefined;
          }
          cp.toggleDir = activeToggleDir;
        }
      }
    }

    // Section-level categories with locale-specific labels
    const stripped = stripSectionPrefix(section);
    for (const locale of sectionLocales) {
      // Label: use locale-specific curated translation, or find a locale page's own section
      const curated = CURATED_SECTION_TRANSLATIONS[locale]?.[stripped];
      let label = curated ?? stripped;
      // If no curated, check if any canonical page for this locale has a different section
      if (!curated) {
        for (const cp of (contentBySection.get(section) ?? [])) {
          if (cp.locale === locale && cp.doc.section && cp.doc.section !== section) {
            const altStripped = stripSectionPrefix(cp.doc.section);
            label = CURATED_SECTION_TRANSLATIONS[locale]?.[altStripped] ?? altStripped;
            break;
          }
        }
      }
      const existing = categories.find((c) => c.locale === locale && c.sectionDir === sectionDir && !c.toggleDir);
      if (!existing) {
        categories.push({ sectionDir, locale, label, position: sectionPos, key: sectionDir });
      } else {
        existing.position = sectionPos;
      }
    }
    sectionPos++;
  }

  // ── Final-key dedupe per exact route tuple ──
  // Group by: locale, section path (root for Uncategorized), toggleDir, canonicalSlug.
  const routeGroups = new Map<string, CanonicalPage[]>();
  for (const cp of canonicalPages) {
    const sectionComponent = cp.canonicalSection === SECTION_NAMES.UNCATEGORIZED ? "" : toSectionDir(cp.canonicalSection);
    const routeKey = JSON.stringify([cp.locale, sectionComponent, cp.toggleDir ?? "", cp.canonicalSlug]);
    const group = routeGroups.get(routeKey) ?? [];
    group.push(cp);
    routeGroups.set(routeKey, group);
  }

  const dedupedPages: CanonicalPage[] = [];
  for (const [routeKey, group] of routeGroups) {
    if (group.length === 1) {
      dedupedPages.push(group[0]);
      continue;
    }
    // Select winner by rank: real body first, then fallback-backed, then language source, etc.
    group.sort((a, b) => rankForDedupe(a, b, docSourceIndex));
    const winner = group[0];
    const dropped = group.slice(1);
    // Preserve customPropsTitle from dropped if winner lacks it
    if (!winner.customPropsTitle) {
      for (const d of dropped) {
        if (d.customPropsTitle) { winner.customPropsTitle = d.customPropsTitle; break; }
      }
    }
    dedupedPages.push(winner);
    diagnostics.push({
      severity: "warn", category: "duplicate-public-route",
      pageId: winner.pageId, title: winner.title,
      detail: `Winner: ${winner.pageId}; dropped: ${dropped.map((d) => d.pageId).join(", ")} (route: ${routeKey})`,
    });
  }
  canonicalPages.length = 0;
  canonicalPages.push(...dedupedPages);

  // ── Remove Toggle CategoryEntries with no assigned pages ──
  const toggleAssignments = new Map<string, Set<string>>(); // locale+sectionDir+toggleDir → pageIds
  for (const cp of canonicalPages) {
    if (!cp.toggleDir) continue;
    const key = `${cp.locale}/${toSectionDir(cp.canonicalSection)}/${cp.toggleDir}`;
    const s = toggleAssignments.get(key) ?? new Set();
    s.add(cp.pageId);
    toggleAssignments.set(key, s);
  }
  const filteredCategories = categories.filter((c) => {
    if (!c.toggleDir) return true; // section-level, always keep
    const key = `${c.locale}/${c.sectionDir}/${c.toggleDir}`;
    return toggleAssignments.has(key);
  });
  // Replace categories array
  categories.length = 0;
  categories.push(...filteredCategories);
  for (const family of families) {
    if (!family.isContent) continue;
    const missing: string[] = [];
    if (!family.selected.has("es") && !family.selected.has("pt")) { missing.push("ES", "PT"); }
    else { if (!family.selected.has("es")) missing.push("ES"); if (!family.selected.has("pt")) missing.push("PT"); }
    if (missing.length > 0) {
      diagnostics.push({ severity: "warn", category: "missing-translation-children",
        pageId: family.parentDoc.page_id, title: family.parentDoc.title ?? "",
        detail: `Missing locale(s): ${missing.join(", ")}` });
    }
    for (const [locale, member] of family.selected) {
      if (member.languageSource === "fallback" && locale !== "en") {
        diagnostics.push({ severity: "warn", category: "missing-language",
          pageId: member.doc.page_id, title: member.doc.title ?? "",
          detail: `Language property missing/null (fallback), locale defaults to "${locale}"` });
      }
    }
  }

  return { canonicalPages, categories, diagnostics, routeAliases };
}

function rankForDedupe(a: CanonicalPage, b: CanonicalPage, idxMap: Map<string, number>): number {
  // 1. real body first
  if (a.hasBody && !b.hasBody) return -1;
  if (b.hasBody && !a.hasBody) return 1;
  // 2. if both lack real body: EN fallback available before no fallback
  if (!a.hasBody && !b.hasBody) {
    if (a.enFallbackPageId && !b.enFallbackPageId) return -1;
    if (b.enFallbackPageId && !a.enFallbackPageId) return 1;
  }
  // 3. language source: explicit > automated > fallback
  const srcRank: Record<string, number> = { explicit: 0, automated: 1, fallback: 2 };
  const sa = srcRank[a.languageSource] ?? 2;
  const sb = srcRank[b.languageSource] ?? 2;
  if (sa !== sb) return sa - sb;
  // 4. typed over untyped
  const at = manifestElementType(a.doc) !== "" ? 0 : 1;
  const bt = manifestElementType(b.doc) !== "" ? 0 : 1;
  if (at !== bt) return at - bt;
  // 5. non-staging over staging suffix
  const STAGING = /[-_]\d{4}-\d{2}-\d{2}\s*translation/i;
  const as = STAGING.test(a.title) ? 1 : 0;
  const bs = STAGING.test(b.title) ? 1 : 0;
  if (as !== bs) return as - bs;
  // 6. lower canonicalOrder
  if (a.canonicalOrder !== b.canonicalOrder) return a.canonicalOrder - b.canonicalOrder;
  // 7. original input document index
  const ai = idxMap.get(a.pageId) ?? 99999;
  const bi = idxMap.get(b.pageId) ?? 99999;
  return ai - bi;
}

// ── Helpers ──

export function toSectionDir(sectionName: string): string {
  return stripSectionPrefix(sectionName).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sectionSortKey(sec: string): number {
  if (sec === SECTION_NAMES.UNCATEGORIZED) return UNCATEGORIZED_ORDER;
  const m = sec.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}
