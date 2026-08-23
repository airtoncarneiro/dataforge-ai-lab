export const LLM_ERROR_CATEGORIES = Object.freeze([
  "configuration_error",
  "authentication_error",
  "timeout",
  "provider_error",
  "invalid_response",
  "schema_validation_error",
  "invalid_tool_request",
  "refusal",
]);

export class LlmConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LlmConfigurationError";
    this.category = "configuration_error";
    this.code = code;
    this.retryable = false;
  }
}

export class LlmProviderError extends Error {
  constructor({
    category = "provider_error",
    code = "provider_failure",
    message = "The LLM provider could not complete the request.",
    retryable = false,
  } = {}) {
    super(message);
    this.name = "LlmProviderError";
    this.category = LLM_ERROR_CATEGORIES.includes(category) ? category : "provider_error";
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

export function publicError(error) {
  const known = error instanceof LlmConfigurationError || error instanceof LlmProviderError;
  return Object.freeze({
    category: known ? error.category : "provider_error",
    code: known ? error.code : "provider_failure",
    message: known ? error.message : "The LLM provider could not complete the request.",
    retryable: known ? error.retryable : false,
  });
}
