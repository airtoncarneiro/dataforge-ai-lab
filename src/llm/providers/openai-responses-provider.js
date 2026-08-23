import { LlmConfigurationError, LlmProviderError } from "../errors.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function requireSecret(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError(
      "missing_api_key",
      "The LLM provider API key is not configured.",
    );
  }
  return value;
}

function requireModel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError(
      "missing_model",
      "The LLM provider model is not configured.",
    );
  }
  return value;
}

function extractRefusal(response) {
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "refusal") {
        return true;
      }
    }
  }
  return false;
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text;
  }
  const parts = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function extractToolCalls(response) {
  return (response.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: typeof item.call_id === "string"
        ? item.call_id
        : (typeof item.id === "string" ? item.id : null),
      name: item.name,
      arguments: item.arguments,
    }));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

function toProviderTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
}

function buildRequest(request, model) {
  const body = {
    model,
    instructions: request.instructions,
    input: request.messages,
    text: {
      format: {
        type: "json_schema",
        name: "sql_mentor_response",
        schema: request.outputSchema,
        strict: true,
      },
    },
    store: false,
  };
  if (request.tools.length > 0) {
    body.tools = toProviderTools(request.tools);
  }
  const { maxOutputTokens, temperature, topP } = request.parameters;
  if (maxOutputTokens !== undefined) {
    body.max_output_tokens = maxOutputTokens;
  }
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  if (topP !== undefined) {
    body.top_p = topP;
  }
  return body;
}

export class OpenAIResponsesProvider {
  #apiKey;
  #model;
  #fetch;
  #baseUrl;

  constructor({
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
  }) {
    this.#apiKey = requireSecret(apiKey);
    this.#model = requireModel(model);
    if (typeof fetchImpl !== "function") {
      throw new LlmConfigurationError(
        "missing_fetch",
        "A fetch implementation is required for the OpenAI provider.",
      );
    }
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  get name() {
    return "openai";
  }

  get model() {
    return this.#model;
  }

  async generate(request) {
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequest(request, this.#model)),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted || error?.name === "AbortError") {
        throw new LlmProviderError({
          category: "timeout",
          code: "request_timeout",
          message: "The LLM request timed out.",
          retryable: true,
        });
      }
      throw new LlmProviderError({
        category: "provider_error",
        code: "transport_error",
        message: "The LLM provider could not complete the request.",
        retryable: true,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new LlmProviderError({
        category: "authentication_error",
        code: "provider_authentication_failed",
        message: "The LLM provider rejected its configured credentials.",
      });
    }
    if (!response.ok) {
      const retryable = response.status === 408
        || response.status === 409
        || response.status === 429
        || response.status >= 500;
      throw new LlmProviderError({
        category: "provider_error",
        code: "provider_http_error",
        message: "The LLM provider could not complete the request.",
        retryable,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LlmProviderError({
        category: "invalid_response",
        code: "malformed_provider_response",
        message: "The LLM returned an invalid response.",
      });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new LlmProviderError({
        category: "invalid_response",
        code: "malformed_provider_response",
        message: "The LLM returned an invalid response.",
      });
    }
    if (extractRefusal(payload)) {
      return { type: "refusal", requestId: payload.id ?? null };
    }
    if (payload.status === "failed" || payload.status === "incomplete") {
      throw new LlmProviderError({
        category: "provider_error",
        code: payload.status === "incomplete" ? "incomplete_response" : "failed_response",
        message: "The LLM provider could not complete the request.",
        retryable: false,
      });
    }

    const output = extractOutputText(payload);
    const toolCalls = extractToolCalls(payload);
    if (output === null && toolCalls.length === 0) {
      throw new LlmProviderError({
        category: "invalid_response",
        code: "missing_output",
        message: "The LLM response did not contain structured output.",
      });
    }
    return {
      type: "output",
      output,
      toolCalls,
      requestId: typeof payload.id === "string" ? payload.id : null,
      usage: normalizeUsage(payload.usage),
    };
  }
}
