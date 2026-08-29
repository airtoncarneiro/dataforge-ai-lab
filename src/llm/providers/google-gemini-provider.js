import { LlmConfigurationError, LlmProviderError } from "../errors.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_SCHEMA_KEYS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description",
  "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum",
  "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering",
]);
const GEMINI_RESPONSE_SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties",
  "required", "propertyOrdering",
]);

function normalizeGeminiSchema(schema, { responseSchema = false } = {}) {
  if (Array.isArray(schema)) return schema.map((item) => normalizeGeminiSchema(item, { responseSchema }));
  if (schema === null || typeof schema !== "object") return schema;
  const allowedKeys = responseSchema ? GEMINI_RESPONSE_SCHEMA_KEYS : GEMINI_SCHEMA_KEYS;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => allowedKeys.has(key))
    .map(([key, value]) => [key, key === "properties" || key === "$defs"
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeGeminiSchema(child, { responseSchema })]))
      : normalizeGeminiSchema(value, { responseSchema })]));
}

function required(value, code, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError(code, message);
  }
  return value.trim();
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input_tokens: Number.isSafeInteger(value.promptTokenCount) ? value.promptTokenCount : null,
    output_tokens: Number.isSafeInteger(value.candidatesTokenCount) ? value.candidatesTokenCount : null,
    total_tokens: Number.isSafeInteger(value.totalTokenCount) ? value.totalTokenCount : null,
  };
}

function buildRequest(request, { useResponseSchema = false } = {}) {
  const schemaField = useResponseSchema ? "responseSchema" : "responseJsonSchema";
  const body = {
    systemInstruction: { parts: [{ text: request.instructions }] },
    contents: request.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      responseMimeType: "application/json",
      [schemaField]: normalizeGeminiSchema(request.outputSchema, { responseSchema: useResponseSchema }),
    },
  };
  const { maxOutputTokens, temperature, topP } = request.parameters;
  if (maxOutputTokens !== undefined) body.generationConfig.maxOutputTokens = maxOutputTokens;
  if (temperature !== undefined) body.generationConfig.temperature = temperature;
  if (topP !== undefined) body.generationConfig.topP = topP;
  if (request.tools.length > 0) {
    body.tools = [{ functionDeclarations: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: normalizeGeminiSchema(tool.inputSchema),
    })) }];
  }
  return body;
}

function extractResponse(payload) {
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.filter((part) => typeof part.text === "string").map((part) => part.text).join("");
  const toolCalls = parts
    .filter((part) => part.functionCall && typeof part.functionCall.name === "string")
    .map((part) => ({ id: null, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) }));
  if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
    return { type: "refusal", requestId: null };
  }
  if (text === "" && toolCalls.length === 0) {
    throw new LlmProviderError({ category: "invalid_response", code: "missing_output", message: "The LLM response did not contain structured output.", retryable: true });
  }
  return {
    type: "output",
    output: text === "" ? null : text,
    toolCalls,
    requestId: typeof payload.responseId === "string" ? payload.responseId : null,
    usage: normalizeUsage(payload.usageMetadata),
  };
}

export class GoogleGeminiProvider {
  #apiKey;
  #model;
  #fetch;
  #baseUrl;

  constructor({ apiKey, model, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL }) {
    this.#apiKey = required(apiKey, "missing_google_api_key", "Google Gemini API key is missing.");
    this.#model = required(model, "missing_model", "The LLM provider model is not configured.");
    if (typeof fetchImpl !== "function") throw new LlmConfigurationError("missing_fetch", "A fetch implementation is required.");
    this.#fetch = fetchImpl;
    this.#baseUrl = required(baseUrl, "invalid_base_url", "Google Gemini base URL is missing.").replace(/\/$/, "");
  }

  get name() { return "google"; }
  get model() { return this.#model; }

  async generate(request) {
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/models/${encodeURIComponent(this.#model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.#apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest(request, { useResponseSchema: this.#model.startsWith("gemma-") })),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") {
        throw new LlmProviderError({ category: "timeout", code: "request_timeout", message: "The LLM request timed out.", retryable: true });
      }
      throw new LlmProviderError({ category: "provider_error", code: "transport_error", message: "The LLM provider could not complete the request.", retryable: true });
    }
    if (response.status === 401 || response.status === 403) {
      throw new LlmProviderError({ category: "authentication_error", code: "provider_authentication_failed", message: "The LLM provider rejected its configured credentials.", httpStatus: response.status });
    }
    if (!response.ok) {
      const code = response.status === 400 ? "provider_bad_request"
        : response.status === 404 ? "provider_model_not_found"
          : response.status === 408 ? "provider_request_timeout"
            : response.status === 409 ? "provider_conflict"
              : response.status === 429 ? "provider_rate_limited"
                : response.status >= 500 ? "provider_server_error" : "provider_http_error";
      throw new LlmProviderError({ category: "provider_error", code, message: "The LLM provider could not complete the request.", retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500, httpStatus: response.status });
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new LlmProviderError({ category: "invalid_response", code: "malformed_provider_response", message: "The LLM returned an invalid response." });
    }
    try { return extractResponse(payload); } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      throw new LlmProviderError({ category: "invalid_response", code: "malformed_provider_response", message: "The LLM returned an invalid response." });
    }
  }
}
