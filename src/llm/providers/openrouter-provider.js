import { LlmConfigurationError, LlmProviderError } from "../errors.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function required(value, code, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError(code, message);
  }
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

function buildRequest(request, model, {
  structured = true,
  providerPreferences = {},
  responseHealing = false,
} = {}) {
  const body = {
    model,
    messages: [{
      role: "system",
      content: structured
        ? request.instructions
        : `${request.instructions}\n\nOutput contract fallback: return exactly one valid JSON value, with no Markdown, commentary, or code fence. It must conform to this JSON Schema:\n${JSON.stringify(request.outputSchema)}`,
    }, ...request.messages],
  };
  // Presets own their routing configuration. Sending provider preferences can
  // make an otherwise valid preset request ineligible for every endpoint.
  if (!model.startsWith("@preset/")) {
    body.provider = { require_parameters: true, ...providerPreferences };
  }
  if (structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "sql_mentor_response", strict: true, schema: request.outputSchema },
    };
    if (responseHealing) body.plugins = [{ id: "response-healing" }];
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true },
    }));
  }
  if (request.parameters.maxOutputTokens !== undefined) body.max_tokens = request.parameters.maxOutputTokens;
  if (request.parameters.temperature !== undefined) body.temperature = request.parameters.temperature;
  if (request.parameters.topP !== undefined) body.top_p = request.parameters.topP;
  return body;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && typeof part === "object" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return text === "" ? null : text;
  }
  return null;
}

function ensureStructuredJson(output) {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter(Boolean);
  // A few Gemini routes add a short preamble/postamble around the JSON.
  // Extract only a complete top-level object/array; schema validation remains
  // authoritative in the adapter.
  const firstObject = trimmed.search(/[\[{]/);
  const lastObject = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(trimmed.slice(firstObject, lastObject + 1));
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch { /* try the next conservative candidate */ }
  }
  throw new LlmProviderError({
    category: "invalid_response",
    code: "malformed_json",
    message: "The LLM returned malformed structured output.",
    retryable: true,
  });
}

async function readPayload(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return response.json();
  const parseChunk = (line) => {
    const raw = line.slice(5).trim();
    try { return JSON.parse(raw); } catch {
      // Some OmniRouter/Gemini routes emit an unescaped JSON string in
      // delta.content. Recover only that transport field; B11 still performs
      // strict JSON/schema validation on the reconstructed output.
      const match = raw.match(/"content":"([\s\S]*)","finish_reason"/);
      if (!match) return null;
      return { choices: [{ delta: { content: match[1] }, finish_reason: null }] };
    }
  };
  const chunks = String(await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map(parseChunk)
    .filter(Boolean);
  const first = chunks[0];
  if (!first) return null;
  const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
  const toolCalls = [];
  for (const chunk of chunks) {
    for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = call.index ?? toolCalls.length;
      toolCalls[index] ??= { id: null, function: { name: "", arguments: "" } };
      if (typeof call.id === "string") toolCalls[index].id = call.id;
      if (typeof call.function?.name === "string") toolCalls[index].function.name += call.function.name;
      if (typeof call.function?.arguments === "string") toolCalls[index].function.arguments += call.function.arguments;
    }
  }
  return {
    id: first.id,
    choices: [{ message: { content: content || null, tool_calls: toolCalls }, finish_reason: chunks.at(-1)?.choices?.[0]?.finish_reason ?? null }],
    usage: chunks.find((chunk) => chunk.usage)?.usage ?? null,
  };
}

export class OpenAICompatibleProvider {
  #apiKey;
  #model;
  #fetch;
  #baseUrl;
  #structuredFallback;
  #providerPreferences;
  #responseHealing;
  #providerName;

  constructor({
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    structuredFallback = false,
    providerPreferences = {},
    responseHealing = false,
    providerName = "openai-compatible",
  }) {
    this.#apiKey = required(apiKey, "missing_openrouter_api_key", "OpenRouter API key is missing.");
    this.#model = required(model, "missing_model", "The LLM provider model is not configured.");
    if (typeof fetchImpl !== "function") throw new LlmConfigurationError("missing_fetch", "A fetch implementation is required.");
    this.#fetch = fetchImpl;
    this.#baseUrl = required(baseUrl, "invalid_base_url", "OpenRouter base URL is missing.").replace(/\/$/, "");
    this.#structuredFallback = structuredFallback === true;
    this.#providerPreferences = providerPreferences;
    this.#responseHealing = responseHealing === true;
    this.#providerName = providerName;
  }

  get name() { return this.#providerName; }
  get model() { return this.#model; }

  async generate(request) {
    let response;
    const send = (structured) => this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(request, this.#model, {
        structured,
        providerPreferences: this.#providerPreferences,
        responseHealing: this.#responseHealing,
      })),
      signal: request.signal,
    });
    try {
      response = await send(true);
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") {
        throw new LlmProviderError({ category: "timeout", code: "request_timeout", message: "The LLM request timed out.", retryable: true });
      }
      throw new LlmProviderError({ category: "provider_error", code: "transport_error", message: "The LLM provider could not complete the request.", retryable: true });
    }
    // OmniRouter can route to Gemini models that reject OpenAI's json_schema
    // transport option. Depending on the upstream route this may surface as a
    // 4xx or 5xx response. Keep schema validation in B11, but retry the
    // transport once without response_format so compatible models can still
    // return JSON. Authentication failures must never be retried this way.
    if (!response.ok && this.#structuredFallback && ![401, 403].includes(response.status)) {
      try {
        response = await send(false);
      } catch (error) {
        if (request.signal?.aborted || error?.name === "AbortError") {
          throw new LlmProviderError({ category: "timeout", code: "request_timeout", message: "The LLM request timed out.", retryable: true });
        }
        throw new LlmProviderError({ category: "provider_error", code: "transport_error", message: "The LLM provider could not complete the request.", retryable: true });
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new LlmProviderError({ category: "authentication_error", code: "provider_authentication_failed", message: "The LLM provider rejected its configured credentials." });
    }
    if (!response.ok) {
      throw new LlmProviderError({ category: "provider_error", code: "provider_http_error", message: "The LLM provider could not complete the request.", retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500 });
    }
    let payload;
    try { payload = await readPayload(response); } catch {
      throw new LlmProviderError({ category: "invalid_response", code: "malformed_provider_response", message: "The LLM returned an invalid response." });
    }
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== "object") {
      throw new LlmProviderError({ category: "invalid_response", code: "missing_output", message: "The LLM response did not contain structured output.", retryable: true });
    }
    if (typeof message.refusal === "string" && message.refusal !== "") {
      return { type: "refusal", requestId: typeof payload.id === "string" ? payload.id : null };
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({ id: typeof call.id === "string" ? call.id : null, name: call.function?.name, arguments: call.function?.arguments })) : [];
    const output = extractContent(message.content);
    if ((output === null || (typeof output === "string" && output.trim() === "")) && toolCalls.length === 0) {
      throw new LlmProviderError({ category: "invalid_response", code: "missing_output", message: "The LLM response did not contain structured output.", retryable: true });
    }
    return { type: "output", output: ensureStructuredJson(output), toolCalls, requestId: typeof payload.id === "string" ? payload.id : null, usage: normalizeUsage(payload.usage) };
  }
}

// Backwards-compatible export for callers that used the old provider name.
export const OpenRouterProvider = OpenAICompatibleProvider;
