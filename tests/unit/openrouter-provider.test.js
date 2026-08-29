import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderError, OpenRouterProvider } from "../../src/llm/index.js";

const REQUEST = Object.freeze({
  instructions: "System instructions",
  messages: [{ role: "user", content: "Context" }],
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
  tools: [{
    name: "get_context",
    description: "Read context",
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  }],
  parameters: { maxOutputTokens: 321, temperature: 0.2, topP: 0.9 },
  signal: new AbortController().signal,
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test("provider OpenRouter usa Chat Completions compatível com Structured Outputs", async () => {
  let observed;
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "provider/model",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return response({
        id: "or-1",
        choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    },
  });

  const result = await provider.generate(REQUEST);
  const body = JSON.parse(observed.init.body);

  assert.equal(observed.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(observed.init.headers.Authorization, "Bearer sk-or-test-only");
  assert.deepEqual(body.messages, [
    { role: "system", content: "System instructions" },
    { role: "user", content: "Context" },
  ]);
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "sql_mentor_response", strict: true, schema: REQUEST.outputSchema },
  });
  assert.deepEqual(body.tools[0], {
    type: "function",
    function: {
      name: "get_context",
      description: "Read context",
      parameters: REQUEST.tools[0].inputSchema,
      strict: true,
    },
  });
  assert.equal(body.max_tokens, 321);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(result, {
    type: "output",
    output: "{\"answer\":\"ok\"}",
    toolCalls: [],
    requestId: "or-1",
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  });
});

test("provider OpenRouter normaliza tool calls e sanitiza autenticação", async () => {
  const toolsProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "provider/model",
    fetchImpl: async () => response({
      id: "or-tool",
      choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "get_context", arguments: "{}" } }] } }],
    }),
  });
  assert.deepEqual(await toolsProvider.generate(REQUEST), {
    type: "output",
    output: null,
    toolCalls: [{ id: "call-1", name: "get_context", arguments: "{}" }],
    requestId: "or-tool",
    usage: null,
  });

  const authProvider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "provider/model",
    fetchImpl: async () => response({ error: { message: "sk-or-leaked" } }, 401),
  });
  await assert.rejects(
    () => authProvider.generate(REQUEST),
    (error) => error instanceof LlmProviderError
      && error.category === "authentication_error"
      && !error.message.includes("sk-or-leaked"),
  );
});

test("provider OpenRouter aceita conteúdo em partes ou objeto estruturado", async () => {
  const parts = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "provider/model",
    fetchImpl: async () => response({ id: "or-parts", choices: [{ message: { content: [{ type: "text", text: '{"answer":"ok"}' }] } }] }),
  });
  assert.equal((await parts.generate(REQUEST)).output, "{\"answer\":\"ok\"}");

  const object = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "provider/model",
    fetchImpl: async () => response({ id: "or-object", choices: [{ message: { content: { answer: "ok" } } }] }),
  });
  assert.deepEqual((await object.generate(REQUEST)).output, { answer: "ok" });
});

test("provider OpenRouter agrega resposta SSE do OmniRouter", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "auto/gemini",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      async text() {
        const first = JSON.stringify({ id: "sse-1", choices: [{ delta: { role: "assistant" } }] });
        const second = JSON.stringify({ choices: [{ delta: { content: '{"answer":"ok"}' } }] });
        return `data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`;
      },
    }),
  });
  const result = await provider.generate(REQUEST);
  assert.equal(result.requestId, "sse-1");
  assert.equal(result.output, '{"answer":"ok"}');
});

test("provider OmniRouter faz fallback quando o modelo rejeita json_schema", async () => {
  const bodies = [];
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "auto/gemini",
    structuredFallback: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) return response({ error: { message: "response_format unsupported" } }, 400);
      return response({ id: "fallback-1", choices: [{ message: { content: '{"answer":"ok"}' } }] });
    },
  });
  const result = await provider.generate(REQUEST);
  assert.equal(result.output, '{"answer":"ok"}');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
  assert.match(bodies[1].messages[0].content, /Output contract fallback/);
  assert.match(bodies[1].messages[0].content, /"answer"/);
});

test("provider OmniRouter tenta fallback após erro 5xx do roteador", async () => {
  let calls = 0;
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "auto/gemini",
    structuredFallback: true,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      if (calls === 1) {
        assert.ok(body.response_format);
        return response({ error: { message: "upstream rejected request" } }, 503);
      }
      assert.equal(body.response_format, undefined);
      return response({ id: "fallback-5xx", choices: [{ message: { content: '{"answer":"ok"}' } }] });
    },
  });
  assert.equal((await provider.generate(REQUEST)).output, '{"answer":"ok"}');
  assert.equal(calls, 2);
});

test("provider OmniRouter recupera content JSON não escapado no SSE", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "sk-or-test-only",
    model: "auto/gemini",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      async text() {
        return String.raw`data: {"id":"sse-raw","choices":[{"delta":{"content":"{"ok":true}","finish_reason":null}}]}` + "\n\n"
          + "data: [DONE]\n\n";
      },
    }),
  });
  const result = await provider.generate(REQUEST);
  assert.equal(result.output, '{"ok":true}');
});
