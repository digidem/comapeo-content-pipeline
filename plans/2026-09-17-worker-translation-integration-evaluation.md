# Architectural Evaluation & Decision: Cloudflare Worker Integration for AI Translation Generation

**Status:** Decided / Accepted  
**Date:** 2026-09-17  
**Context:** Follow-up evaluation for `TASKS.md` §1 ("Evaluate Worker integration: Decide whether translation generation should remain an on-demand CLI operator tool or be exposed via a Cloudflare Worker admin route (e.g. `POST /admin/translate/missing`) or triggered on English page publication").

---

## 1. Executive Summary

We evaluated whether to integrate AI translation generation into the Cloudflare Worker runtime (either via Notion webhook triggers on English page publication or via protected admin HTTP endpoints like `POST /admin/translate/missing` / `POST /admin/translate/page`).

**Decision:**
1. **Maintain AI translation generation as an on-demand CLI operator tool** (`bun scripts/translate-missing.ts`).
2. **Do NOT integrate translation generation directly into the Cloudflare Worker runtime or automatic webhook triggers.**
3. **Optionally provide a GitHub Actions workflow (`workflow_dispatch`)** for remote or scheduled batch execution if non-CLI operators need a web interface.

---

## 2. Context & Background

The CoMapeo Content Pipeline currently runs two primary execution environments:

1. **Cloudflare Worker Runtime (`src/worker/`)**:
   - Serves webhooks from Notion (`POST /webhooks/notion`).
   - Manages an asynchronous Cloudflare Queue (`SYNC_QUEUE`) to pull published Notion pages into Cloudflare R2 storage and Cloudflare D1 database.
   - Exposes operational admin routes (`POST /admin/sync/page`, `POST /admin/sync/changed`, `POST /admin/manifest/regenerate`).
   - Optimized for fast, bounded, sub-second execution (Markdown parsing, AST conversion, R2 put, D1 insert).

2. **CLI Operator Tooling (`scripts/translate-missing.ts`)**:
   - Inverted block translation engine (`src/lib/ai-translator.ts`, `src/lib/block-translator.ts`, `src/lib/page-translator.ts`).
   - Connects to LLM providers (OpenAI GPT-4o, DeepSeek Chat, Poolside Laguna) using chunked chat completions with strict bilingual glossary rules and equation delimiter tracking.
   - Writes translated block trees directly back to Notion under container parents with `Publish Status: "Automated translations generated"` and `Language: "PT - automated"` / `"ES - automated"`.
   - Re-generates and synchronizes local manifests and static site documentation artifacts.

The question under review: Should translation generation be brought inside the Cloudflare Worker runtime or automatically triggered when English documentation is published?

---

## 3. Evaluation of Options

### Option A: Automatic Webhook Trigger on English Page Publication

*Architecture:* The Worker receives a Notion webhook indicating an English page reached `Publish Status: "Published"`. The Worker automatically kicks off AI translation for Spanish and Portuguese, writes the new pages into Notion, and syncs them to R2.

#### Pros:
- Zero manual operator effort required when new English content is published.
- Potential for near-instant automated translations appearing in Notion.

#### Cons & Risks:
- **Runaway Costs & Webhook Storms:** Notion triggers multiple webhooks in rapid succession during normal editing sessions (e.g., autosave, block moves, metadata edits). Without complex distributed debouncing in D1, this can trigger dozens of redundant LLM translation requests, consuming hundreds of thousands of LLM tokens and causing quota exhaustion.
- **Race Conditions & Notion API Rate Limits:** Notion API strictly throttles integration requests (~3 requests/second per token). Concurrently writing dozens of multi-block translated trees back to Notion in response to webhook spikes will inevitably trigger `429 Too Many Requests` or write conflicts.
- **Violation of Editorial Workflow:** Per [`docs/editorial-review-workflow.md`](../docs/editorial-review-workflow.md), AI-generated translations are first drafts intended to live in `Publish Status: "Automated translations generated"`. Once human translators or editors make manual improvements, automated runs must respect the human-edit safety lock. Automatic webhook triggers risk overwriting or desynchronizing human-reviewed translations whenever minor English edits occur.
- **Failure Visibility:** When an LLM fails (hallucinations, token exhaustion, dropping equation tokens, formatting degradation), webhook-driven background execution fails silently or deposits error logs in Cloudflare tail workers where editors never see them.

---

### Option B: Cloudflare Worker Admin Route (`POST /admin/translate/missing`)

*Architecture:* Expose `POST /admin/translate/missing` and `POST /admin/translate/page` on the Cloudflare Worker, protected by `ADMIN_TOKEN` bearer authentication.

#### Pros:
- Operators can trigger translation remotely via HTTP without needing a local Git checkout or Node/Bun environment.
- Centralizes pipeline operations in the Worker API.

#### Cons & Risks:
- **Cloudflare Worker Wall-Clock Timeouts:** Standard Cloudflare Workers have a 30-second wall-clock HTTP execution limit. Translating a single medium-to-large page with multiple chunks of Notion blocks through DeepSeek/OpenAI typically requires 15–45 seconds; batch translating several pages requires several minutes. A synchronous HTTP endpoint will fail with HTTP 524 (Worker Timeout).
- **Queue Complexity:** To circumvent HTTP timeouts, the Worker would need a dedicated translation queue (`TRANSLATION_QUEUE`) with multi-minute timeouts, state tracking in D1, retry policies, and dead-letter queues. This adds significant architectural footprint and operational complexity.
- **Credential Footprint:** Requires adding production LLM API keys (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`) to Cloudflare Worker secrets alongside existing database and webhook keys, expanding the secret management surface area.
- **User Interface Gap:** Notion content editors work in the Notion web UI, not in `curl` or Postman. Exposing a curl-based admin route on the Worker provides no usability advantage over a local CLI command or a GitHub Actions button.

---

### Option C: Dedicated CLI Operator Tool (`bun scripts/translate-missing.ts`) (Current State)

*Architecture:* Operators run `bun scripts/translate-missing.ts` on demand from their terminal, using local environment variables or CLI flags.

#### Pros:
- **Full Operational Control:** Operators inspect what will change before executing using `--dry-run`, target specific locales (`--locale es`), single pages (`--page <slug>`), or batch limits (`--limit 5`).
- **Safety Locks by Default:** Built-in safeguards prevent overwriting human-edited translations unless explicitly commanded with `--force`.
- **Zero Worker Resource Contention:** Keeps Cloudflare Workers dedicated to lightweight webhook ingestion and fast syncs, eliminating Worker queue bloat and memory/CPU limits.
- **Rich Diagnostic Feedback:** Real-time terminal output with progress bars, chunk retry status, delimiter validation warnings, and Notion page URLs.
- **Runtime Agnosticism Maintained:** Keeps `src/lib/` modular and pure, with credentials scoped to CLI invocation.

#### Cons:
- Requires the operator to have a terminal, Git clone, and Bun installed.

---

### Option D: GitHub Actions Workflow (`workflow_dispatch`)

*Architecture:* A GitHub Actions workflow in `.github/workflows/translate-docs.yml` wraps `bun scripts/translate-missing.ts`, parameterized with dropdown inputs (`locale`, `page`, `dry-run`, `limit`).

#### Pros:
- Combines the unlimited execution time (up to 6 hours) and rich logging of the CLI with a zero-setup browser UI for non-technical editors.
- Secrets (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `NOTION_TOKEN`) are securely stored in GitHub Repository Secrets.
- Can be scheduled on a weekly cron (e.g., Sunday night dry-run reporting missing translations via issue or Slack/Discord notification).

#### Cons:
- Small CI workflow configuration to maintain.

---

## 4. Architectural Decision & Rationale

| Evaluation Criteria | Option A (Webhook) | Option B (Worker Admin Route) | Option C (CLI Tool) | Option D (GitHub Actions) |
|---|---|---|---|---|
| **Execution Time Limits** | ❌ 30s limit / Queue bound | ❌ 30s limit / Queue bound | ✅ Unlimited | ✅ 6 hours |
| **Editorial Safety Lock** | ❌ High risk of overwriting | ⚠️ Manual token trigger | ✅ Enforced by default | ✅ Enforced by default |
| **Rate Limit / 429 Handling** | ❌ Complex queue retries | ❌ Complex queue retries | ✅ Handled with backoff | ✅ Handled with backoff |
| **Operator Observability** | ❌ Hidden in CF logs | ❌ Raw JSON responses | ✅ Rich interactive logs | ✅ Clean GitHub CI logs |
| **Token Cost Control** | ❌ Danger of runaway calls | ⚠️ Manual curl | ✅ Explicit operator scope | ✅ Explicit operator scope |
| **Infra & Secret Footprint** | ❌ High (LLM secrets in CF) | ❌ High (LLM secrets in CF) | ✅ Local `.env` | ✅ GitHub Secrets |
| **Ease of Use for Editors** | ⚠️ No UI / automatic | ❌ Requires curl/Postman | ⚠️ Requires terminal | ✅ Browser button |

### Core Rationales:

1. **Translations are Editorial Artifacts, Not Cache Invalidation:**
   In content pipelines, static generation and cache synchronization are deterministic, sub-second operations suitable for webhooks. AI translations are non-deterministic, cost-incurring, and require human review. Coupling automated generation directly to page save webhooks creates fragile feedback loops and uncontrolled API spend.

2. **Cloudflare Worker Runtime Constraints:**
   Cloudflare Workers are designed for low-latency, edge routing and event distribution. Long-running LLM batch generation spanning multiple minutes with streaming API calls and Notion rate-limit backoffs belongs in an asynchronous batch runner (CLI or CI runner), not inside the edge router.

3. **Human-in-the-Loop Workflow Alignment:**
   Our editorial workflow explicitly establishes that AI translations are staged in Notion under `Publish Status: "Automated translations generated"` for human review. On-demand batch execution allows translation runs to align with editorial cycles and sprints, rather than firing continuously on every minor draft update.

---

## 5. Conclusion & Action Plan

1. **Worker Integration Decision:** Translation generation will **not** be incorporated into `src/worker/index.ts` or Notion webhook listeners.
2. **Maintenance:** Maintain `scripts/translate-missing.ts` as the primary, production-grade translation engine.
3. **Optional Future Extension:** If editors require a browser-based trigger without terminal access, implement a GitHub Actions `workflow_dispatch` workflow wrapping `bun scripts/translate-missing.ts`.
4. **Task Resolution:** Mark the task in `TASKS.md` §1 as completed with reference to this evaluation document.
