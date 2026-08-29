import { LlmConfigurationError, LlmProviderError } from "../errors.js";

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const OMNIROUTE_SCHEMA_KEYS = new Set([
  "type", "description", "enum", "items", "anyOf", "oneOf", "properties",
  "required", "additionalProperties",
]);

function normalizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => OMNIROUTE_SCHEMA_KEYS.has(key))
    .map(([key, value]) => [key, key === "properties"
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeSchema(child)]))
      : normalizeSchema(value)]));
}

function required(value, code, message) {
  if (typeof value !== "string" || value.trim() === "") throw new LlmConfigurationError(code, message);
  return value.trim();
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input_tokens: Number.isSafeInteger(value.prompt_tokens) ? value.prompt_tokens : null,
    output_tokens: Number.isSafeInteger(value.completion_tokens) ? value.completion_tokens : null,
    total_tokens: Number.isSafeInteger(value.total_tokens) ? value.total_tokens : null,
  };
}

function buildRequest(request) {
  const messages = [
    { role: "system", content: request.instructions },
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const body = {
    model: request.model,
    stream: false,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "sql_mentor_output", strict: true, schema: normalizeSchema(request.outputSchema) },
    },
  };
  const { maxOutputTokens, temperature, topP } = request.parameters;
  if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens;
  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } }));
  }
  return body;
}

function extractResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new LlmProviderError({ category: "invalid_response", code: "missing_output", message: "The LLM response did not contain structured output.", retryable: true });
  if (message.refusal) return { type: "refusal", requestId: payload.id ?? null };
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls
    .filter((call) => call?.type === "function" && typeof call.function?.name === "string")
    .map((call) => ({ id: typeof call.id === "string" ? call.id : null, name: call.function.name, arguments: call.function.arguments ?? "{}" })) : [];
  const output = typeof message.content === "string" ? message.content : null;
  if (output === null && toolCalls.length === 0) throw new LlmProviderError({ category: "invalid_response", code: "missing_output", message: "The LLM response did not contain structured output.", retryable: true });
  return { type: "output", output, toolCalls, requestId: typeof payload.id === "string" ? payload.id : null, usage: normalizeUsage(payload.usage) };
}

export class OmniRouteProvider {
  #apiKey;
  #model;
  #fetch;
  #baseUrl;

  constructor({ apiKey, model, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL }) {
    this.#apiKey = required(apiKey, "missing_omniroute_api_key", "OmniRoute API key is missing.");
    this.#model = required(model, "missing_model", "The LLM provider model is not configured.");
    if (typeof fetchImpl !== "function") throw new LlmConfigurationError("missing_fetch", "A fetch implementation is required.");
    this.#fetch = fetchImpl;
    this.#baseUrl = required(baseUrl, "invalid_base_url", "OmniRoute base URL is missing.").replace(/\/$/, "");
  }

  get name() { return "omniroute"; }
  get model() { return this.#model; }

  async generate(request) {
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest({ ...request, model: this.#model })),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") throw new LlmProviderError({ category: "timeout", code: "request_timeout", message: "The LLM request timed out.", retryable: true });
      throw new LlmProviderError({ category: "provider_error", code: "transport_error", message: "The LLM provider could not complete the request.", retryable: true });
    }
    if (response.status === 401 || response.status === 403) throw new LlmProviderError({ category: "authentication_error", code: "provider_authentication_failed", message: "The LLM provider rejected its configured credentials.", httpStatus: response.status });
    if (!response.ok) {
      const code = response.status === 400 ? "provider_bad_request" : response.status === 404 ? "provider_model_not_found" : response.status === 408 ? "provider_request_timeout" : response.status === 429 ? "provider_rate_limited" : response.status >= 500 ? "provider_server_error" : "provider_http_error";
      throw new LlmProviderError({ category: "provider_error", code, message: "The LLM provider could not complete the request.", retryable: response.status === 408 || response.status === 429 || response.status >= 500, httpStatus: response.status });
    }
    let payload;
    try { payload = await response.json(); } catch { throw new LlmProviderError({ category: "invalid_response", code: "malformed_provider_response", message: "The LLM returned an invalid response." }); }
    return extractResponse(payload);
  }
}
