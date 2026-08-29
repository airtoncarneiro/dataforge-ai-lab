import assert from "node:assert/strict";
import test from "node:test";

import { GoogleGeminiProvider } from "../../src/llm/index.js";

const REQUEST = Object.freeze({
  instructions: "Return the requested JSON.",
  messages: [{ role: "user", content: "Context" }],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string", description: "Short answer" } },
  },
  tools: [],
  parameters: { maxOutputTokens: 321, temperature: 0.2, topP: 0.9 },
  signal: new AbortController().signal,
});

test("Google Gemini traduz contrato neutro para generateContent estruturado", async () => {
  let observed;
  const provider = new GoogleGeminiProvider({
    apiKey: "google-test-only",
    model: "gemma-4-26b-a4b-it",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            responseId: "google-1",
            candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
          };
        },
      };
    },
  });

  assert.deepEqual(await provider.generate(REQUEST), {
    type: "output",
    output: '{"answer":"ok"}',
    toolCalls: [],
    requestId: "google-1",
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  });
  const body = JSON.parse(observed.init.body);
  assert.equal(observed.url, "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent");
  assert.equal(observed.init.headers["x-goog-api-key"], "google-test-only");
  assert.deepEqual(body.generationConfig, {
    responseMimeType: "application/json",
    responseJsonSchema: REQUEST.outputSchema,
    maxOutputTokens: 321,
    temperature: 0.2,
    topP: 0.9,
  });
});
