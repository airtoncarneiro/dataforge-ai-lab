import assert from "node:assert/strict";
import test from "node:test";

import { OmniRouteProvider } from "../../src/llm/index.js";

const REQUEST = {
  instructions: "Return JSON.", messages: [{ role: "user", content: "Context" }],
  outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
  tools: [], parameters: { maxOutputTokens: 123, temperature: 0 }, signal: new AbortController().signal,
};

test("OmniRoute traduz o contrato para Chat Completions estruturado", async () => {
  let observed;
  const provider = new OmniRouteProvider({ apiKey: "omni-test-only", model: "auto/coding", fetchImpl: async (url, init) => {
    observed = { url, init };
    return { ok: true, status: 200, async json() { return { id: "omni-1", choices: [{ message: { role: "assistant", content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }; } };
  } });
  assert.deepEqual(await provider.generate(REQUEST), { type: "output", output: '{"answer":"ok"}', toolCalls: [], requestId: "omni-1", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
  const body = JSON.parse(observed.init.body);
  assert.equal(observed.url, "http://localhost:20128/v1/chat/completions");
  assert.equal(observed.init.headers.Authorization, "Bearer omni-test-only");
  assert.equal(body.model, "auto/coding");
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format.json_schema.schema, REQUEST.outputSchema);
  assert.deepEqual(body.messages, [{ role: "system", content: "Return JSON." }, { role: "user", content: "Context" }]);
});

test("OmniRoute remove keywords de JSON Schema não suportadas pelo provider", async () => {
  let body;
  const provider = new OmniRouteProvider({ apiKey: "omni-test-only", model: "auto/coding", fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"answer":"ok"}' } }] }; } };
  } });
  await provider.generate({ ...REQUEST, outputSchema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", minLength: 1, pattern: "^[A-Z]+$", uniqueItems: true } } } });
  const schema = body.response_format.json_schema.schema;
  assert.deepEqual(schema.properties.answer, { type: "string" });
  assert.equal(schema.additionalProperties, false);
});

test("OmniRoute normaliza tool calls e erros HTTP sem expor payload", async () => {
  const provider = new OmniRouteProvider({ apiKey: "omni-test-only", model: "auto/coding", fetchImpl: async () => ({ ok: false, status: 429, async json() { return { secret: "must-not-leak" }; } }) });
  await assert.rejects(() => provider.generate(REQUEST), (error) => error.code === "provider_rate_limited" && error.retryable && !error.message.includes("secret"));
});
