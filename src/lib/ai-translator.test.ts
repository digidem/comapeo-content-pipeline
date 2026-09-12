import { describe, it, expect, vi } from "vitest";
import { AITranslator, type TranslationRequest } from "./ai-translator.js";
import { loadGlossary, formatGlossaryPrompt } from "./glossary.js";

describe("AITranslator", () => {
  const glossary = loadGlossary();

  it("sends prompt with system instructions and parses JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                p1: "Toque em **Observações** para iniciar.",
                h1: "Visão geral",
              }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      baseUrl: "https://mock.api/v1",
      model: "test-model",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const request: TranslationRequest = {
      targetLocale: "pt",
      blocks: [
        { id: "p1", text: "Tap **Observations** to begin." },
        { id: "h1", text: "Overview" },
      ],
      glossaryPrompt: formatGlossaryPrompt(glossary, "pt"),
    };

    const result = await translator.translate(request);

    expect(result).toEqual({
      p1: "Toque em **Observações** para iniciar.",
      h1: "Visão geral",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, req] = mockFetch.mock.calls[0];
    expect(url).toBe("https://mock.api/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Portuguese");
    expect(body.messages[0].content).toContain("Observações");
  });

  it("handles markdown code fences in LLM output", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "```json\n{\n  \"b1\": \"Hola mundo\"\n}\n```",
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "es",
      blocks: [{ id: "b1", text: "Hello world" }],
    });

    expect(result).toEqual({ b1: "Hola mundo" });
  });

  it("handles models that return { blocks: [...] } structure (like Laguna)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                blocks: [
                  { id: "b1", text: "Texto 1" },
                  { id: "b2", text: "Texto 2" },
                ],
              }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [
        { id: "b1", text: "Text 1" },
        { id: "b2", text: "Text 2" },
      ],
    });

    expect(result).toEqual({
      b1: "Texto 1",
      b2: "Texto 2",
    });
  });

  it("retries when response has missing IDs and succeeds on subsequent try", async () => {
    const mockFetch = vi
      .fn()
      // First attempt: missing "b2"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Traduzido 1" }),
              },
            },
          ],
        }),
      })
      // Second attempt: returns both "b1" and "b2"
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  b1: "Traduzido 1",
                  b2: "Traduzido 2",
                }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [
        { id: "b1", text: "Text 1" },
        { id: "b2", text: "Text 2" },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      b1: "Traduzido 1",
      b2: "Traduzido 2",
    });
  });

  it("throws descriptive error when API request fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    const translator = new AITranslator({
      apiKey: "bad-key",
      maxRetries: 1,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      translator.translate({
        targetLocale: "pt",
        blocks: [{ id: "b1", text: "Text" }],
      }),
    ).rejects.toThrow("Translation API error (401 Unauthorized): Invalid API key");
  });

  it("batches translation requests when blocks exceed batchSize", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ b1: "1", b2: "2" }) } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ b3: "3" }) } }],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      batchSize: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [
        { id: "b1", text: "1" },
        { id: "b2", text: "2" },
        { id: "b3", text: "3" },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ b1: "1", b2: "2", b3: "3" });
  });

  it("throws error when batchSize is not a positive integer", () => {
    expect(() => new AITranslator({ batchSize: 0 })).toThrow("batchSize must be a positive integer");
    expect(() => new AITranslator({ batchSize: -5 })).toThrow("batchSize must be a positive integer");
    expect(() => new AITranslator({ batchSize: 2.5 })).toThrow("batchSize must be a positive integer");
  });

  it("retries when response contains empty string for a non-empty block", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "" }),
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Valid translation" }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "Original" }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ b1: "Valid translation" });
  });

  it("validates timeoutMs and batchSize values in constructor", () => {
    expect(() => new AITranslator({ apiKey: "test-key", timeoutMs: NaN })).toThrow(
      "timeoutMs must be a positive number",
    );
    expect(() => new AITranslator({ apiKey: "test-key", timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive number",
    );
    expect(() => new AITranslator({ apiKey: "test-key", timeoutMs: -100 })).toThrow(
      "timeoutMs must be a positive number",
    );
    expect(() => new AITranslator({ apiKey: "test-key", batchSize: 0 })).toThrow(
      "batchSize must be a positive integer",
    );
    expect(() => new AITranslator({ apiKey: "test-key", batchSize: -5 })).toThrow(
      "batchSize must be a positive integer",
    );

    const validTranslator = new AITranslator({
      apiKey: "test-key",
      timeoutMs: 5000,
      batchSize: 10,
    });

    expect((validTranslator as unknown as { timeoutMs: number }).timeoutMs).toBe(5000);
    expect((validTranslator as unknown as { batchSize: number }).batchSize).toBe(10);
  });

  it("includes instruction to preserve equation delimiters verbatim in system prompt", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                p1: "A fórmula é $E = mc^2$.",
              }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "p1", text: "The formula is $E = mc^2$." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, req] = mockFetch.mock.calls[0];
    const body = JSON.parse(req.body);
    const systemPrompt = body.messages[0].content;
    expect(systemPrompt).toContain("Preserve all inline math and equations exactly, maintaining their $...$ or $$...$$ delimiters");
  });

  it("retries when LLM drops equation delimiters and succeeds on subsequent try", async () => {
    const mockFetch = vi
      .fn()
      // First attempt: dropped $ delimiters around E = mc^2
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "A fórmula é E = mc^2." }),
              },
            },
          ],
        }),
      })
      // Second attempt: properly preserved delimiters
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "A fórmula é $E = mc^2$." }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "The formula is $E = mc^2$." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify retry message was sent
    const [, secondReq] = mockFetch.mock.calls[1];
    const secondBody = JSON.parse(secondReq.body);
    const retryPrompt = secondBody.messages[secondBody.messages.length - 1].content;
    expect(retryPrompt).toContain("Error: The translation dropped equation delimiters ($...$ or $$...$$)");
    expect(retryPrompt).toContain("$E = mc^2$");

    expect(result).toEqual({ b1: "A fórmula é $E = mc^2$." });
  });

  it("restores dropped equation delimiters on final attempt if LLM persistently drops them", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ b1: "A taxa para avaliação de x é alta." }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 1,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "The rate for evaluation of $x$ is high." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ b1: "A taxa para avaliação de $x$ é alta." });
  });

  it("retries when LLM drops equation delimiters for a duplicate occurrence of the same equation", async () => {
    const mockFetch = vi
      .fn()
      // First attempt: preserved first $x$, but dropped second $x$
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Seja $x$ e depois x." }),
              },
            },
          ],
        }),
      })
      // Second attempt: both preserved
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Seja $x$ e depois $x$." }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "Let $x$ and then $x$." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ b1: "Seja $x$ e depois $x$." });
  });

  it("retries when LLM duplicates an equation and succeeds on subsequent try", async () => {
    const mockFetch = vi
      .fn()
      // First attempt: duplicated $x$ as $x$ $x$
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Seja $x$ $x$ agora." }),
              },
            },
          ],
        }),
      })
      // Second attempt: single $x$
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Seja $x$ agora." }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "Let $x$ now." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ b1: "Seja $x$ agora." });
  });

  it("retries when LLM adds an unexpected equation not present in source", async () => {
    const mockFetch = vi
      .fn()
      // First attempt: hallucinates $y$
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Resultado com $y$ inesperado." }),
              },
            },
          ],
        }),
      })
      // Second attempt: clean translation without equation
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ b1: "Resultado sem fórmula." }),
              },
            },
          ],
        }),
      });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await translator.translate({
      targetLocale: "pt",
      blocks: [{ id: "b1", text: "Result without formula." }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ b1: "Resultado sem fórmula." });
  });

  it("throws validation error when LLM persistently duplicates equations after all retries", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ b1: "Seja $x$ $x$ sempre." }),
            },
          },
        ],
      }),
    });

    const translator = new AITranslator({
      apiKey: "test-key",
      maxRetries: 1,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(
      translator.translate({
        targetLocale: "pt",
        blocks: [{ id: "b1", text: "Let $x$ always." }],
      }),
    ).rejects.toThrow(/Translation validation failed: equation mismatch/);
  });
});

describe("AITranslator provider resolution", () => {
  const resolved = (t: AITranslator) =>
    t as unknown as { apiKey: string; baseUrl: string; model: string };

  it("defaults to OpenAI when only OPENAI_API_KEY is set", () => {
    const t = new AITranslator({ env: { OPENAI_API_KEY: "sk-openai-test" } });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("sk-openai-test");
    expect(baseUrl).toBe("https://api.openai.com/v1");
    expect(model).toBe("gpt-4o");
  });

  it("defaults to DeepSeek when only DEEPSEEK_API_KEY is set", () => {
    const t = new AITranslator({ env: { DEEPSEEK_API_KEY: "sk-deepseek-test" } });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("sk-deepseek-test");
    expect(baseUrl).toBe("https://api.deepseek.com/v1");
    expect(model).toBe("deepseek-chat");
  });

  it("defaults to Poolside for a sky_ prefixed key", () => {
    const t = new AITranslator({ env: { POOLSIDE_API_KEY: "sky_poolside-test" } });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("sky_poolside-test");
    expect(baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(model).toBe("poolside/laguna-s-2.1");
  });

  it("defaults to Poolside when the key matches POOLSIDE_API_KEY and no base URLs are set", () => {
    const t = new AITranslator({ env: { POOLSIDE_API_KEY: "poolside-laguna-key" } });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("poolside-laguna-key");
    expect(baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(model).toBe("poolside/laguna-s-2.1");
  });

  it("allows explicit config.baseUrl to override Poolside default endpoint", () => {
    const t = new AITranslator({
      baseUrl: "https://custom-proxy.example.com/v1",
      env: {
        POOLSIDE_API_KEY: "poolside-laguna-key",
      },
    });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("poolside-laguna-key");
    expect(baseUrl).toBe("https://custom-proxy.example.com/v1");
    expect(model).toBe("poolside/laguna-s-2.1");
  });

  it("allows TRANSLATION_BASE_URL to override provider endpoint", () => {
    const t = new AITranslator({
      env: {
        POOLSIDE_API_KEY: "poolside-laguna-key",
        TRANSLATION_BASE_URL: "https://translation-proxy.example.com/v1",
      },
    });
    const { baseUrl, model } = resolved(t);
    expect(baseUrl).toBe("https://translation-proxy.example.com/v1");
    expect(model).toBe("poolside/laguna-s-2.1");
  });

  it("defaults to DeepSeek when the configured baseUrl contains 'deepseek'", () => {
    const t = new AITranslator({
      apiKey: "some-key",
      baseUrl: "https://gateway.example.com/deepseek/v1",
    });
    const { baseUrl, model } = resolved(t);
    expect(baseUrl).toBe("https://gateway.example.com/deepseek/v1");
    expect(model).toBe("deepseek-chat");
  });

  it("defaults to DeepSeek when OPENAI_BASE_URL contains 'deepseek'", () => {
    const t = new AITranslator({
      env: {
        OPENAI_API_KEY: "sk-openai-test",
        OPENAI_BASE_URL: "https://open.deepseek.com/v1",
      },
    });
    const { baseUrl, model } = resolved(t);
    expect(baseUrl).toBe("https://open.deepseek.com/v1");
    expect(model).toBe("deepseek-chat");
  });

  it("applies provider-specific model overrides", () => {
    const openai = new AITranslator({
      env: { OPENAI_API_KEY: "sk-openai-test", OPENAI_MODEL: "gpt-4o-mini" },
    });
    expect(resolved(openai).model).toBe("gpt-4o-mini");

    const deepseek = new AITranslator({
      env: { DEEPSEEK_API_KEY: "sk-deepseek-test", DEEPSEEK_MODEL: "deepseek-reasoner" },
    });
    expect(resolved(deepseek).model).toBe("deepseek-reasoner");
  });

  it("prefers TRANSLATION_* overrides over provider-specific env vars", () => {
    const t = new AITranslator({
      env: {
        TRANSLATION_API_KEY: "generic-key",
        TRANSLATION_BASE_URL: "https://llm.example.com/v1/",
        TRANSLATION_MODEL: "custom-model",
        OPENAI_API_KEY: "sk-openai-test",
        OPENAI_MODEL: "gpt-4o",
      },
    });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("generic-key");
    expect(baseUrl).toBe("https://llm.example.com/v1");
    expect(model).toBe("custom-model");
  });

  it("resolves keys in order TRANSLATION > OPENAI > DEEPSEEK > POOLSIDE", () => {
    const all = {
      TRANSLATION_API_KEY: "generic-key",
      OPENAI_API_KEY: "sk-openai-test",
      DEEPSEEK_API_KEY: "sk-deepseek-test",
      POOLSIDE_API_KEY: "poolside-laguna-key",
    };
    const { TRANSLATION_API_KEY: _t, ...withoutTranslation } = all;
    const { OPENAI_API_KEY: _o, ...withoutOpenai } = withoutTranslation;
    const { DEEPSEEK_API_KEY: _d, ...withoutDeepseek } = withoutOpenai;

    expect(resolved(new AITranslator({ env: all })).apiKey).toBe("generic-key");
    expect(resolved(new AITranslator({ env: withoutTranslation })).apiKey).toBe("sk-openai-test");
    expect(resolved(new AITranslator({ env: withoutOpenai })).apiKey).toBe("sk-deepseek-test");
    expect(resolved(new AITranslator({ env: withoutDeepseek })).apiKey).toBe("poolside-laguna-key");
  });

  it("prefers explicit config values over environment variables", () => {
    const t = new AITranslator({
      apiKey: "explicit-key",
      baseUrl: "https://proxy.example.com/v1",
      model: "explicit-model",
      env: {
        TRANSLATION_API_KEY: "generic-key",
        OPENAI_API_KEY: "sk-openai-test",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_MODEL: "gpt-4o",
      },
    });
    const { apiKey, baseUrl, model } = resolved(t);
    expect(apiKey).toBe("explicit-key");
    expect(baseUrl).toBe("https://proxy.example.com/v1");
    expect(model).toBe("explicit-model");
  });

  it("strips trailing slashes from the resolved base URL", () => {
    const t = new AITranslator({
      env: { OPENAI_API_KEY: "sk-openai-test", OPENAI_BASE_URL: "https://api.openai.com/v1///" },
    });
    expect(resolved(t).baseUrl).toBe("https://api.openai.com/v1");
  });

  it("sends requests to the DeepSeek endpoint when DEEPSEEK_API_KEY is set (no real network)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ b1: "Hola mundo" }) } }],
      }),
    });

    const translator = new AITranslator({
      env: { DEEPSEEK_API_KEY: "sk-deepseek-test" },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await translator.translate({
      targetLocale: "es",
      blocks: [{ id: "b1", text: "Hello world" }],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, req] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(req.headers.Authorization).toBe("Bearer sk-deepseek-test");
    expect(JSON.parse(req.body).model).toBe("deepseek-chat");
  });

  it("never sends OpenAI credentials to DeepSeek endpoints when env vars coexist", () => {
    const t = new AITranslator({
      env: {
        OPENAI_API_KEY: "sk-openai-secret",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
        DEEPSEEK_MODEL: "deepseek-chat",
      },
    });
    expect(t.apiKey).toBe("sk-openai-secret");
    // OpenAI provider group must use OpenAI endpoint, NOT DEEPSEEK_BASE_URL
    expect(t.baseUrl).toBe("https://api.openai.com/v1");
    expect(t.model).toBe("gpt-4o");
  });

  it("never sends DeepSeek credentials to OpenAI endpoints when env vars coexist", () => {
    const t = new AITranslator({
      env: {
        DEEPSEEK_API_KEY: "sk-deepseek-secret",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_MODEL: "gpt-4o",
      },
    });
    expect(t.apiKey).toBe("sk-deepseek-secret");
    // DeepSeek provider group must use DeepSeek endpoint, NOT OPENAI_BASE_URL
    expect(t.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(t.model).toBe("deepseek-chat");
  });

  it("never sends Poolside credentials to OpenAI or DeepSeek endpoints when env vars coexist", () => {
    const t = new AITranslator({
      env: {
        POOLSIDE_API_KEY: "sky_poolside_secret",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      },
    });
    expect(t.apiKey).toBe("sky_poolside_secret");
    expect(t.baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(t.model).toBe("poolside/laguna-s-2.1");
  });

  it("normalizes empty string overrides and does not suppress provider defaults", () => {
    const t = new AITranslator({
      env: {
        OPENAI_API_KEY: "sk-openai-key",
        TRANSLATION_BASE_URL: "",
        TRANSLATION_MODEL: "   ",
        OPENAI_BASE_URL: "",
        OPENAI_MODEL: "",
      },
    });
    expect(t.apiKey).toBe("sk-openai-key");
    expect(t.baseUrl).toBe("https://api.openai.com/v1");
    expect(t.model).toBe("gpt-4o");
  });

  it("normalizes empty string overrides for DeepSeek provider group", () => {
    const t = new AITranslator({
      env: {
        DEEPSEEK_API_KEY: "sk-deepseek-key",
        TRANSLATION_BASE_URL: "",
        TRANSLATION_MODEL: "",
        DEEPSEEK_BASE_URL: "  ",
        DEEPSEEK_MODEL: "",
      },
    });
    expect(t.apiKey).toBe("sk-deepseek-key");
    expect(t.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(t.model).toBe("deepseek-chat");
  });

  it("honors provider-specific base URL and model when explicit apiKey matches DeepSeek", () => {
    const t = new AITranslator({
      apiKey: "sk-deepseek-key",
      env: {
        DEEPSEEK_API_KEY: "sk-deepseek-key",
        DEEPSEEK_BASE_URL: "https://custom-deepseek-proxy.example.com/v1",
        DEEPSEEK_MODEL: "deepseek-coder",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      },
    });
    expect(t.apiKey).toBe("sk-deepseek-key");
    expect(t.baseUrl).toBe("https://custom-deepseek-proxy.example.com/v1");
    expect(t.model).toBe("deepseek-coder");
  });

  it("honors provider-specific base URL and model when explicit apiKey matches OpenAI", () => {
    const t = new AITranslator({
      apiKey: "sk-openai-key",
      env: {
        OPENAI_API_KEY: "sk-openai-key",
        OPENAI_BASE_URL: "https://custom-openai-proxy.example.com/v1",
        OPENAI_MODEL: "gpt-4o-mini",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      },
    });
    expect(t.apiKey).toBe("sk-openai-key");
    expect(t.baseUrl).toBe("https://custom-openai-proxy.example.com/v1");
    expect(t.model).toBe("gpt-4o-mini");
  });

  it("does not leak provider-specific base URL to unknown or opaque explicit keys", () => {
    const t = new AITranslator({
      apiKey: "sk-unknown-opaque-key",
      env: {
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
        DEEPSEEK_MODEL: "deepseek-chat",
      },
    });
    expect(t.apiKey).toBe("sk-unknown-opaque-key");
    // Unknown key must NOT inherit DEEPSEEK_BASE_URL
    expect(t.baseUrl).toBe("https://api.openai.com/v1");
    expect(t.model).toBe("gpt-4o");
    expect(t.hasApiKey).toBe(true);
  });

  it("resolves endpoint and model in no-key branch with provider env vars", () => {
    const t = new AITranslator({
      env: {
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
        DEEPSEEK_MODEL: "deepseek-chat",
      },
    });
    expect(t.apiKey).toBe("");
    expect(t.hasApiKey).toBe(false);
    expect(t.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(t.model).toBe("deepseek-chat");
  });
});
