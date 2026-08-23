import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createLlmAdapterFromEnv,
  FakeLlmProvider,
  LlmAdapter,
  LlmConfigurationError,
} from "../../src/llm/index.js";

const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["message", "next_action"],
  properties: {
    message: { type: "string", minLength: 1 },
    next_action: { type: "string", enum: ["retry", "practice"] },
  },
});

const REQUEST = Object.freeze({
  instructions: "Return a structured pedagogical suggestion.",
  messages: [{ role: "user", content: "Minha tentativa" }],
  outputSchema: OUTPUT_SCHEMA,
});

function adapterFor(scenario, options = {}) {
  const provider = new FakeLlmProvider({
    model: options.model ?? "fake-model-v1",
    ...(Array.isArray(scenario) ? { scenarios: scenario } : { scenario }),
  });
  return {
    provider,
    adapter: new LlmAdapter({
      provider,
      policyVersion: "llm-contract-v0.1",
      timeoutMs: options.timeoutMs ?? 50,
      maxRetries: options.maxRetries ?? 0,
      parameters: options.parameters ?? { temperature: 0, maxOutputTokens: 300 },
    }),
  };
}

test("provider fake retorna resposta valida normalizada e schema-validada", async () => {
  const { adapter, provider } = adapterFor({
    type: "valid",
    output: { message: "Tente novamente.", next_action: "retry" },
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
  });

  const result = await adapter.generate(REQUEST);

  assert.deepEqual(result, {
    status: "ok",
    provider: "fake",
    model: "fake-model-v1",
    policy_version: "llm-contract-v0.1",
    output: { message: "Tente novamente.", next_action: "retry" },
    tool_calls: [],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    request_id: "fake-request-1",
    attempts: 1,
    error: null,
  });
  assert.equal(provider.callCount, 1);
  assert.equal(provider.calls[0].instructions, REQUEST.instructions);
  assert.deepEqual(provider.calls[0].parameters, { temperature: 0, maxOutputTokens: 300 });
});

test("rejeita resposta que nao atende ao schema esperado", async () => {
  const { adapter } = adapterFor({
    type: "valid",
    output: { message: "Mensagem", next_action: "advance" },
  });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "schema_validation_error");
  assert.equal(result.error.code, "output_schema_mismatch");
  assert.ok(result.error.details.some((detail) => detail.path === "/next_action"));
});

test("rejeita campo desconhecido quando additionalProperties proibe", async () => {
  const { adapter } = adapterFor({
    type: "valid",
    output: { message: "Mensagem", next_action: "retry", secret_extra: true },
  });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "schema_validation_error");
  assert.ok(result.error.details.some((detail) => detail.keyword === "additionalProperties"));
  assert.doesNotMatch(JSON.stringify(result), /secret_extra/);
});

test("distingue JSON malformado de incompatibilidade com schema", async () => {
  const { adapter } = adapterFor({ type: "invalid" });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "error");
  assert.deepEqual(result.error, {
    category: "invalid_response",
    code: "malformed_json",
    message: "The LLM returned malformed structured output.",
    retryable: false,
  });
});

test("timeout respeita limite de retries tecnicos", async () => {
  const { adapter, provider } = adapterFor(
    { type: "timeout" },
    { timeoutMs: 5, maxRetries: 1 },
  );

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "timeout");
  assert.equal(result.error.retryable, true);
  assert.equal(result.attempts, 2);
  assert.equal(provider.callCount, 2);
});

test("provider error nao transitorio e normalizado sem retry", async () => {
  const { adapter, provider } = adapterFor(
    { type: "provider_error", retryable: false },
    { maxRetries: 2 },
  );

  const result = await adapter.generate(REQUEST);

  assert.equal(result.error.category, "provider_error");
  assert.equal(result.error.code, "fake_provider_error");
  assert.equal(result.attempts, 1);
  assert.equal(provider.callCount, 1);
});

test("provider error transitorio pode recuperar dentro do limite", async () => {
  const { adapter, provider } = adapterFor([
    { type: "provider_error", retryable: true },
    { type: "valid", output: { message: "Recuperado", next_action: "practice" } },
  ], { maxRetries: 1 });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(provider.callCount, 2);
});

test("erro de autenticacao nao e repetido", async () => {
  const { adapter, provider } = adapterFor(
    { type: "authentication_error" },
    { maxRetries: 2 },
  );

  const result = await adapter.generate(REQUEST);

  assert.equal(result.error.category, "authentication_error");
  assert.equal(result.error.retryable, false);
  assert.equal(provider.callCount, 1);
});

test("recusa do modelo possui categoria explicita", async () => {
  const { adapter } = adapterFor({ type: "refusal" });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "refusal");
  assert.equal(result.error.code, "model_refusal");
});

test("tool request e aceito somente para tool registrada e argumentos validos", async () => {
  const tool = {
    name: "get_allowed_schema",
    description: "Return the allowed educational schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["exercise_id"],
      properties: { exercise_id: { type: "string" } },
    },
  };
  const { adapter } = adapterFor({
    type: "valid",
    output: null,
    toolCalls: [{
      id: "call-1",
      name: "get_allowed_schema",
      arguments: "{\"exercise_id\":\"ex-1\"}",
    }],
  });

  const result = await adapter.generate({ ...REQUEST, tools: [tool] });

  assert.equal(result.status, "tool_request");
  assert.deepEqual(result.tool_calls, [{
    id: "call-1",
    name: "get_allowed_schema",
    arguments: { exercise_id: "ex-1" },
  }]);
});

test("tool desconhecida e rejeitada sem execucao", async () => {
  const { adapter } = adapterFor({
    type: "valid",
    output: null,
    toolCalls: [{ id: "call-1", name: "shell", arguments: "{}" }],
  });

  const result = await adapter.generate(REQUEST);

  assert.equal(result.error.category, "invalid_tool_request");
  assert.equal(result.error.code, "unknown_tool");
});

test("configuracao ausente falha antes de qualquer chamada externa", () => {
  assert.throws(
    () => createLlmAdapterFromEnv({
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "configured-model",
      LLM_POLICY_VERSION: "policy-v1",
    }),
    (error) => error instanceof LlmConfigurationError && error.code === "missing_openai_api_key",
  );
});

test("modelo e parametros sao configuraveis por ambiente sem expor API key", () => {
  const adapter = createLlmAdapterFromEnv({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-sensitive-value",
    OPENAI_MODEL: "configured-model",
    LLM_POLICY_VERSION: "prompt-v7",
    LLM_TIMEOUT_MS: "1234",
    LLM_MAX_RETRIES: "3",
    LLM_MAX_OUTPUT_TOKENS: "456",
    LLM_TEMPERATURE: "0.25",
    LLM_TOP_P: "0.8",
  }, { fetchImpl: async () => { throw new Error("not called"); } });

  assert.deepEqual(adapter.configuration, {
    provider: "openai",
    model: "configured-model",
    policy_version: "prompt-v7",
    timeout_ms: 1234,
    max_retries: 3,
    parameters: { maxOutputTokens: 456, temperature: 0.25, topP: 0.8 },
  });
  assert.doesNotMatch(JSON.stringify(adapter.configuration), /sk-sensitive-value/);
});

test("erro inesperado e sanitizado sem stack, segredo ou detalhe interno", async () => {
  const sensitive = "sk-secret-value postgres://admin:password@internal/db";
  const provider = {
    name: "custom",
    model: "custom-model",
    async generate() {
      throw new Error(`failure ${sensitive}`);
    },
  };
  const adapter = new LlmAdapter({
    provider,
    policyVersion: "policy-v1",
    timeoutMs: 50,
    maxRetries: 0,
  });

  const result = await adapter.generate(REQUEST);
  const serialized = JSON.stringify(result);

  assert.equal(result.error.category, "provider_error");
  assert.doesNotMatch(serialized, /sk-secret-value|postgres:\/\/|password|stack/i);
});

test("fake e deterministico para a mesma entrada e configuracao", async () => {
  const scenario = {
    type: "valid",
    output: { message: "Mesmo resultado", next_action: "practice" },
  };
  const first = adapterFor(scenario);
  const second = adapterFor(scenario);

  assert.deepEqual(
    await first.adapter.generate(REQUEST),
    await second.adapter.generate(REQUEST),
  );
  assert.deepEqual(first.provider.calls, second.provider.calls);
});

async function javascriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await javascriptFiles(target));
    } else if (entry.name.endsWith(".js")) {
      files.push(target);
    }
  }
  return files;
}

test("dominio e servicos deterministas nao dependem de SDK ou provider LLM", async () => {
  const roots = ["src/domain", "src/learner-model", "src/knowledge-graph", "src/adaptive-decision"];
  const files = (await Promise.all(roots.map(javascriptFiles))).flat();
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  for (const source of sources) {
    assert.doesNotMatch(source, /from\s+["']openai["']|src\/llm|llm\/providers/);
  }
  assert.equal(packageJson.dependencies.openai, undefined);
});
