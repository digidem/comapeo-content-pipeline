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
});
