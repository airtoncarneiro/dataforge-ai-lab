import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmProviderError,
  OpenAIResponsesProvider,
} from "../../src/llm/index.js";

const PROVIDER_REQUEST = Object.freeze({
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
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
  }],
  parameters: { maxOutputTokens: 321, temperature: 0.2, topP: 0.9 },
  signal: new AbortController().signal,
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("provider OpenAI traduz contrato neutro para Responses API Structured Outputs", async () => {
  let observed;
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return jsonResponse({
        id: "resp-1",
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "{\"answer\":\"ok\"}" }],
        }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      });
    },
  });

  const result = await provider.generate(PROVIDER_REQUEST);
  const body = JSON.parse(observed.init.body);

  assert.equal(observed.url, "https://api.openai.com/v1/responses");
  assert.equal(observed.init.headers.Authorization, "Bearer sk-test-only");
  assert.equal(body.model, "configured-model");
  assert.deepEqual(body.input, PROVIDER_REQUEST.messages);
  assert.deepEqual(body.text.format, {
    type: "json_schema",
    name: "sql_mentor_response",
    schema: PROVIDER_REQUEST.outputSchema,
    strict: true,
  });
  assert.deepEqual(body.tools[0], {
    type: "function",
    name: "get_context",
    description: "Read context",
    parameters: PROVIDER_REQUEST.tools[0].inputSchema,
    strict: true,
  });
  assert.equal(body.max_output_tokens, 321);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.store, false);
  assert.deepEqual(result, {
    type: "output",
    output: "{\"answer\":\"ok\"}",
    toolCalls: [],
    requestId: "resp-1",
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  });
});

test("provider normaliza function calls sem executar tools", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async () => jsonResponse({
      id: "resp-tool",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call-1",
        name: "get_context",
        arguments: "{}",
      }],
    }),
  });

  const result = await provider.generate(PROVIDER_REQUEST);

  assert.equal(result.output, null);
  assert.deepEqual(result.toolCalls, [{ id: "call-1", name: "get_context", arguments: "{}" }]);
});

test("provider classifica autenticacao sem expor corpo da resposta", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async () => jsonResponse({ internal: "sk-leaked-by-provider" }, 401),
  });

  await assert.rejects(
    () => provider.generate(PROVIDER_REQUEST),
    (error) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.category, "authentication_error");
      assert.doesNotMatch(error.message, /sk-test-only|sk-leaked-by-provider/);
      return true;
    },
  );
});

test("provider trata resposta HTTP transitoria como retryable", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async () => jsonResponse({ internal: "do not expose" }, 429),
  });

  await assert.rejects(
    () => provider.generate(PROVIDER_REQUEST),
    (error) => error.category === "provider_error" && error.retryable === true,
  );
});

test("provider reconhece refusal sem devolver texto sensivel", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async () => jsonResponse({
      id: "resp-refusal",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "internal refusal details" }],
      }],
    }),
  });

  assert.deepEqual(await provider.generate(PROVIDER_REQUEST), {
    type: "refusal",
    requestId: "resp-refusal",
  });
});

test("provider trata JSON de transporte malformado", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "sk-test-only",
    model: "configured-model",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError("sensitive response body"); },
    }),
  });

  await assert.rejects(
    () => provider.generate(PROVIDER_REQUEST),
    (error) => error.category === "invalid_response"
      && error.code === "malformed_provider_response"
      && !error.message.includes("sensitive response body"),
  );
});
