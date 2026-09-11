/**
 * AI Translation client using native fetch and OpenAI-compatible completions.
 *
 * Implements inverted block translation with JSON-in / JSON-out, glossary
 * injection, and a hard deterministic ID verification gate.
 */

export interface AITranslatorConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
  batchSize?: number;
  fetchFn?: typeof fetch;
}

export interface TranslationBlock {
  id: string;
  text: string;
}

export interface TranslationRequest {
  targetLocale: "pt" | "es" | string;
  blocks: TranslationBlock[];
  glossaryPrompt?: string;
  pageContext?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class AITranslator {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxRetries: number;
  private timeoutMs: number;
  private batchSize: number;
  private fetchFn: typeof fetch;

  constructor(config: AITranslatorConfig = {}) {
    if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize <= 0)) {
      throw new Error(`batchSize must be a positive integer, got ${config.batchSize}`);
    }

    const globalProcess =
      typeof globalThis !== "undefined" && "process" in globalThis
        ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
        : undefined;
    const env = globalProcess?.env ?? {};

    const poolsideKey = env.POOLSIDE_API_KEY;
    this.apiKey =
      config.apiKey ??
      env.TRANSLATION_API_KEY ??
      env.OPENAI_API_KEY ??
      poolsideKey ??
      "";

    const isPoolside =
      this.apiKey.startsWith("sky_") ||
      (!env.TRANSLATION_BASE_URL && !env.OPENAI_BASE_URL && Boolean(poolsideKey) && this.apiKey === poolsideKey);
    const defaultBaseUrl = isPoolside
      ? "https://inference.poolside.ai/v1"
      : "https://api.openai.com/v1";
    const defaultModel = isPoolside
      ? "poolside/laguna-s-2.1"
      : "deepseek-chat";

    const rawBaseUrl =
      config.baseUrl ??
      env.TRANSLATION_BASE_URL ??
      env.OPENAI_BASE_URL ??
      defaultBaseUrl;
    this.baseUrl = rawBaseUrl.replace(/\/+$/, "");
    this.model =
      config.model ??
      env.TRANSLATION_MODEL ??
      env.OPENAI_MODEL ??
      defaultModel;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 180000;
    this.batchSize = config.batchSize ?? 25;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Translate a list of blocks into the target locale.
   * Batches large documents and validates all block IDs in the response.
   */
  async translate(request: TranslationRequest): Promise<Record<string, string>> {
    if (!request.blocks || request.blocks.length === 0) {
      return {};
    }

    if (request.blocks.length <= this.batchSize) {
      return this.translateBatch(request.blocks, request);
    }

    const aggregated: Record<string, string> = {};
    for (let i = 0; i < request.blocks.length; i += this.batchSize) {
      const chunk = request.blocks.slice(i, i + this.batchSize);
      const translatedChunk = await this.translateBatch(chunk, request);
      Object.assign(aggregated, translatedChunk);
    }

    return aggregated;
  }

  private async translateBatch(
    blocks: TranslationBlock[],
    request: TranslationRequest,
  ): Promise<Record<string, string>> {
    const targetLangName =
      request.targetLocale === "pt"
        ? "Portuguese (pt-BR / Brazilian Portuguese)"
        : request.targetLocale === "es"
          ? "Spanish (es-419 / Latin American Spanish)"
          : request.targetLocale;

    let systemPrompt = [
      `You are an expert technical translator for CoMapeo, an offline-first mobile and desktop mapping tool designed for Indigenous and local communities.`,
      `Translate the provided documentation blocks from English to ${targetLangName}.`,
      ``,
      `Instructions:`,
      `1. Preserve all inline Markdown syntax verbatim (\`**bold**\`, \`*italic*\`, \`[text](url)\`, \`\` \`code\` \`\`).`,
      `2. Never translate URLs inside markdown links [text](url).`,
      `3. Preserve all technical symbols, emojis, and variables.`,
      `4. Input is a JSON object with an array of blocks: { "blocks": [ { "id": "...", "text": "..." } ] }.`,
      `5. Output MUST be a JSON object mapping EVERY input ID to its translated string: { "<id>": "<translated_text>" }.`,
      `6. Return an entry for EVERY block ID. Do not omit any ID and do not add new IDs.`,
      `7. Output valid, raw JSON only. Do not wrap in Markdown fences, do not output explanations or notes.`,
      `8. Preserve all placeholder tokens formatted like ⟦TAG_0⟧ verbatim and in their exact positions without altering, removing, or translating them.`,
    ].join("\n");

    if (request.glossaryPrompt) {
      systemPrompt += `\n\n### CoMapeo Domain Glossary:\n${request.glossaryPrompt}\nStrictly adhere to these approved term translations.`;
    }

    if (request.pageContext) {
      systemPrompt += `\n\nContext for this page: ${request.pageContext}`;
    }

    const userPrompt = JSON.stringify({
      blocks: blocks.map((b) => ({ id: b.id, text: b.text })),
    });

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        let rawContent = "";

        try {
          const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              messages,
              temperature: 0.1,
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(
              `Translation API error (${res.status} ${res.statusText}): ${errText}`,
            );
          }

          const data = (await res.json()) as ChatCompletionResponse;
          rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
        } finally {
          clearTimeout(timeoutId);
        }

        // Strip markdown code fences if LLM wrapped output
        const cleanedJson = rawContent
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        let parsed: Record<string, string>;
        try {
          const rawParsed = JSON.parse(cleanedJson) as unknown;
          if (rawParsed && typeof rawParsed === "object") {
            const maybeObj = rawParsed as { blocks?: unknown };
            if (Array.isArray(maybeObj.blocks)) {
              const entries = (maybeObj.blocks as Array<{ id?: string; text?: string }>)
                .filter((b) => b && typeof b.id === "string")
                .map((b) => [b.id!, String(b.text ?? "")]);
              parsed = Object.fromEntries(entries);
            } else if (Array.isArray(rawParsed)) {
              const entries = (rawParsed as Array<{ id?: string; text?: string }>)
                .filter((b) => b && typeof b.id === "string")
                .map((b) => [b.id!, String(b.text ?? "")]);
              parsed = Object.fromEntries(entries);
            } else {
              parsed = rawParsed as Record<string, string>;
            }
          } else {
            parsed = {};
          }
        } catch (parseErr) {
          throw new Error(
            `Failed to parse AI translation JSON: ${String(parseErr)}. Raw response: ${rawContent}`,
            { cause: parseErr },
          );
        }

        // Verify that every input block ID is present and has non-empty text if input was non-empty
        const missingOrEmptyIds = blocks
          .filter((b) => {
            if (!(b.id in parsed)) return true;
            const val = parsed[b.id];
            if (typeof val !== "string") return true;
            if (b.text.trim().length > 0 && val.trim().length === 0) return true;
            return false;
          })
          .map((b) => b.id);

        if (missingOrEmptyIds.length > 0) {
          const errMessage = `Response missing or empty for ${missingOrEmptyIds.length} block IDs: ${missingOrEmptyIds.slice(0, 5).join(", ")}`;
          if (attempt < this.maxRetries) {
            messages.push({ role: "assistant", content: rawContent });
            messages.push({
              role: "user",
              content: `Your previous response was missing or had empty translations for the following block IDs: ${missingOrEmptyIds.join(", ")}. Please output the complete JSON object with all block IDs and valid translations.`,
            });
            continue;
          }
          throw new Error(`Translation validation failed: ${errMessage} after ${this.maxRetries} attempts`);
        }

        return parsed;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === this.maxRetries || lastError.message.includes("Translation API error (401")) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error("Translation failed unexpectedly");
  }
}
