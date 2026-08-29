import {
  LlmConfigurationError,
  LlmProviderError,
  publicError,
} from "./errors.js";
import { NullLogger, assertLogger, emitSafely } from "../logging/index.js";
import { compileOutputSchema } from "./schema-validator.js";

const MESSAGE_ROLES = Object.freeze(["user", "assistant"]);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function cloneJson(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError();
    }
    return JSON.parse(serialized);
  } catch {
    throw new LlmConfigurationError(
      "invalid_request",
      `${label} must contain only JSON-serializable values.`,
    );
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError("invalid_request", `${label} must be a non-empty string.`);
  }
  return value;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new LlmConfigurationError("invalid_request", "messages must be an array.");
  }

  return messages.map((message, index) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new LlmConfigurationError(
        "invalid_request",
        `messages[${index}] must be an object.`,
      );
    }
    const keys = Object.keys(message);
    if (keys.some((key) => !["role", "content"].includes(key))) {
      throw new LlmConfigurationError(
        "invalid_request",
        `messages[${index}] contains an unsupported field.`,
      );
    }
    if (!MESSAGE_ROLES.includes(message.role)) {
      throw new LlmConfigurationError(
        "invalid_request",
        `messages[${index}].role must be user or assistant.`,
      );
    }
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(cloneJson(message.content, `messages[${index}].content`));
    return Object.freeze({ role: message.role, content });
  });
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    throw new LlmConfigurationError("invalid_request", "tools must be an array.");
  }
  const names = new Set();
  return tools.map((tool, index) => {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
      throw new LlmConfigurationError("invalid_request", `tools[${index}] must be an object.`);
    }
    const keys = Object.keys(tool);
    if (keys.some((key) => !["name", "description", "inputSchema"].includes(key))) {
      throw new LlmConfigurationError(
        "invalid_request",
        `tools[${index}] contains an unsupported field.`,
      );
    }
    const name = nonEmptyString(tool.name, `tools[${index}].name`);
    if (!TOOL_NAME_PATTERN.test(name) || names.has(name)) {
      throw new LlmConfigurationError(
        "invalid_request",
        `tools[${index}].name must be unique and contain only safe identifier characters.`,
      );
    }
    names.add(name);
    const inputSchema = cloneJson(tool.inputSchema, `tools[${index}].inputSchema`);
    compileOutputSchema(inputSchema);
    return Object.freeze({
      name,
      description: nonEmptyString(tool.description, `tools[${index}].description`),
      inputSchema: deepFreeze(inputSchema),
    });
  });
}

function normalizeUsage(usage) {
  if (usage === null || usage === undefined) {
    return null;
  }
  const inputTokens = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null;
  const outputTokens = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null;
  const totalTokens = Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : null;
  return Object.freeze({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  });
}

function balancedJsonCandidate(value) {
  const starts = new Set(["{", "["]);
  for (let start = 0; start < value.length; start += 1) {
    if (!starts.has(value[start])) continue;
    const opening = value[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0 && character === closing) return value.slice(start, index + 1);
        if (depth < 0) break;
      }
    }
  }
  return null;
}

function parseStructuredOutput(output) {
  if (typeof output !== "string") return cloneJson(output, "provider output");
  const text = output.trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const balanced = balancedJsonCandidate(text);
  if (balanced) candidates.push(balanced);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch { /* try the next representation */ }
  }
  throw new LlmProviderError({
    category: "invalid_response",
    code: "malformed_json",
    message: "The LLM returned malformed structured output.",
    retryable: true,
  });
}

function normalizeToolCalls(toolCalls, tools) {
  if (!Array.isArray(toolCalls)) {
    throw new LlmProviderError({
      category: "invalid_response",
      code: "malformed_tool_calls",
      message: "The LLM returned an invalid tool request.",
    });
  }
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  return toolCalls.map((call) => {
    const tool = call && toolsByName.get(call.name);
    if (!tool) {
      throw new LlmProviderError({
        category: "invalid_tool_request",
        code: "unknown_tool",
        message: "The LLM requested a tool that is not registered.",
      });
    }
    const args = parseStructuredOutput(call.arguments);
    const validation = compileOutputSchema(tool.inputSchema)(args);
    if (!validation.valid) {
      throw new LlmProviderError({
        category: "invalid_tool_request",
        code: "tool_arguments_schema_mismatch",
        message: "The LLM returned invalid arguments for a registered tool.",
      });
    }
    return deepFreeze({
      id: typeof call.id === "string" ? call.id : null,
      name: call.name,
      arguments: args,
    });
  });
}

function providerIdentity(provider) {
  return Object.freeze({
    provider: typeof provider?.name === "string" ? provider.name : "unknown",
    model: typeof provider?.model === "string" ? provider.model : "unknown",
  });
}

export class LlmAdapter {
  #provider;
  #policyVersion;
  #timeoutMs;
  #maxRetries;
  #parameters;
  #logger;

  constructor({
    provider,
    policyVersion,
    timeoutMs = 30_000,
    maxRetries = 1,
    parameters = {},
    logger = new NullLogger(),
  }) {
    if (!provider || typeof provider.generate !== "function") {
      throw new LlmConfigurationError(
        "invalid_provider",
        "An LLM provider with a generate function is required.",
      );
    }
    this.#provider = provider;
    this.#policyVersion = nonEmptyString(policyVersion, "policyVersion");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new LlmConfigurationError("invalid_timeout", "timeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new LlmConfigurationError(
        "invalid_retries",
        "maxRetries must be a non-negative integer.",
      );
    }
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#parameters = deepFreeze(cloneJson(parameters, "parameters"));
    this.#logger = assertLogger(logger);
  }

  get configuration() {
    return deepFreeze({
      ...providerIdentity(this.#provider),
      policy_version: this.#policyVersion,
      timeout_ms: this.#timeoutMs,
      max_retries: this.#maxRetries,
      parameters: cloneJson(this.#parameters, "parameters"),
    });
  }

  async generate({ instructions, messages, outputSchema, tools = [] }) {
    const identity = providerIdentity(this.#provider);
    const startedAt = Date.now();
    let attempts = 0;
    try {
      const schema = cloneJson(outputSchema, "outputSchema");
      const validateOutput = compileOutputSchema(schema);
      const request = deepFreeze({
        instructions: nonEmptyString(instructions, "instructions"),
        messages: normalizeMessages(messages),
        outputSchema: deepFreeze(schema),
        tools: Object.freeze(normalizeTools(tools)),
        parameters: this.#parameters,
        policyVersion: this.#policyVersion,
      });

      for (attempts = 1; attempts <= this.#maxRetries + 1; attempts += 1) {
        try {
          const response = await this.#generateWithTimeout(request);
          if (!response || typeof response !== "object" || Array.isArray(response)) {
            throw new LlmProviderError({
              category: "invalid_response",
              code: "malformed_provider_response",
              message: "The LLM returned an invalid response.",
            });
          }
          if (response.type === "refusal") {
            throw new LlmProviderError({
              category: "refusal",
              code: "model_refusal",
              message: "The model refused to produce the requested output.",
            });
          }
          if (response.type !== "output") {
            throw new LlmProviderError({
              category: "invalid_response",
              code: "malformed_provider_response",
              message: "The LLM returned an invalid response.",
            });
          }

          const toolCalls = normalizeToolCalls(response.toolCalls ?? [], request.tools);
          if (response.output === null || response.output === undefined) {
            if (toolCalls.length === 0) {
              throw new LlmProviderError({
                category: "invalid_response",
                code: "missing_output",
                message: "The LLM response did not contain structured output.",
              });
            }
            const result = deepFreeze({
              status: "tool_request",
              ...identity,
              policy_version: this.#policyVersion,
              output: null,
              tool_calls: toolCalls,
              usage: normalizeUsage(response.usage),
              request_id: typeof response.requestId === "string" ? response.requestId : null,
              attempts,
              error: null,
            });
            this.#log(result, startedAt);
            return result;
          }

          const output = parseStructuredOutput(response.output);
          const validation = validateOutput(output);
          if (!validation.valid) {
            const mismatch = new LlmProviderError({
              category: "schema_validation_error",
              code: "output_schema_mismatch",
              message: "The LLM output did not match the expected schema.",
            });
            mismatch.validationErrors = validation.errors;
            throw mismatch;
          }

          const result = deepFreeze({
            status: "ok",
            ...identity,
            policy_version: this.#policyVersion,
            output: deepFreeze(output),
            tool_calls: Object.freeze(toolCalls),
            usage: normalizeUsage(response.usage),
            request_id: typeof response.requestId === "string" ? response.requestId : null,
            attempts,
            error: null,
          });
          this.#log(result, startedAt);
          return result;
        } catch (error) {
          const normalized = this.#normalizeInvocationError(error);
          if (normalized.retryable && attempts <= this.#maxRetries) {
            continue;
          }
          throw normalized;
        }
      }
    } catch (error) {
      const normalized = this.#normalizeInvocationError(error);
      const result = {
        status: "error",
        ...identity,
        policy_version: this.#policyVersion,
        output: null,
        tool_calls: Object.freeze([]),
        usage: null,
        request_id: null,
        attempts,
        error: publicError(normalized),
      };
      if (normalized.validationErrors) {
        result.error = Object.freeze({
          ...result.error,
          details: normalized.validationErrors,
        });
      }
      const frozen = deepFreeze(result);
      this.#log(frozen, startedAt);
      return frozen;
    }
  }

  async #generateWithTimeout(request) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmProviderError({
          category: "timeout",
          code: "request_timeout",
          message: "The LLM request timed out.",
          retryable: true,
        }));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        this.#provider.generate({ ...request, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #normalizeInvocationError(error) {
    if (error instanceof LlmProviderError || error instanceof LlmConfigurationError) {
      return error;
    }
    if (error?.name === "AbortError") {
      return new LlmProviderError({
        category: "timeout",
        code: "request_timeout",
        message: "The LLM request timed out.",
        retryable: true,
      });
    }
    return new LlmProviderError({
      category: "provider_error",
      code: "provider_failure",
      message: "The LLM provider could not complete the request.",
    });
  }

  #log(result, startedAt) {
    emitSafely(this.#logger, {
      timestamp: new Date().toISOString(),
      level: result.status === "error" ? "warn" : "info",
      event_name: result.status === "error" ? "llm.request.failed" : "llm.request.completed",
      policy_version: this.#policyVersion,
      correlation: { llm_request_id: result.request_id },
      operation: {
        status: result.status,
        duration_ms: Math.max(0, Date.now() - startedAt),
        attempts: result.attempts,
      },
      error: result.error,
      data: { provider: result.provider, model: result.model },
    });
  }
}
