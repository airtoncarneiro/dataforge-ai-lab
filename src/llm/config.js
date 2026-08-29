import { LlmAdapter } from "./llm-adapter.js";
import { LlmConfigurationError } from "./errors.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses-provider.js";
import { OpenRouterProvider } from "./providers/openrouter-provider.js";

function required(value, variableName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LlmConfigurationError(
      `missing_${variableName.toLowerCase()}`,
      `Required LLM configuration ${variableName} is missing.`,
    );
  }
  return value.trim();
}

function integer(value, variableName, defaultValue, { min = 0 } = {}) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new LlmConfigurationError(
      `invalid_${variableName.toLowerCase()}`,
      `${variableName} must be an integer greater than or equal to ${min}.`,
    );
  }
  return parsed;
}

function optionalNumber(value, variableName, { min, max }) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new LlmConfigurationError(
      `invalid_${variableName.toLowerCase()}`,
      `${variableName} must be a number between ${min} and ${max}.`,
    );
  }
  return parsed;
}

function loadLlmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER ?? "openai").trim().toLowerCase();
  if (!["openai", "openrouter", "omnirouter"].includes(provider)) {
    throw new LlmConfigurationError(
      "unsupported_provider",
      "The configured LLM provider is not supported.",
    );
  }

  const temperature = optionalNumber(env.LLM_TEMPERATURE, "LLM_TEMPERATURE", {
    min: 0,
    max: 2,
  });
  const topP = optionalNumber(env.LLM_TOP_P, "LLM_TOP_P", { min: 0, max: 1 });
  const parameters = {
    maxOutputTokens: integer(env.LLM_MAX_OUTPUT_TOKENS, "LLM_MAX_OUTPUT_TOKENS", 1_200, {
      min: 1,
    }),
  };
  if (temperature !== undefined) {
    parameters.temperature = temperature;
  }
  if (topP !== undefined) {
    parameters.topP = topP;
  }

  return Object.freeze({
    provider,
    apiKey: ["openrouter", "omnirouter"].includes(provider)
      ? required(
        env.OMNIROUTER_API_KEY ?? env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY,
        provider === "omnirouter" ? "OMNIROUTER_API_KEY" : "OPENROUTER_API_KEY",
      )
      : required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    model: required(env.OPENAI_MODEL, "OPENAI_MODEL"),
    policyVersion: required(env.LLM_POLICY_VERSION, "LLM_POLICY_VERSION"),
    timeoutMs: integer(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS", 30_000, { min: 1 }),
    maxRetries: integer(env.LLM_MAX_RETRIES, "LLM_MAX_RETRIES", 1),
    parameters: Object.freeze(parameters),
  });
}

export function createLlmAdapterFromEnv(
  env = process.env,
  { fetchImpl = globalThis.fetch, logger } = {},
) {
  const config = loadLlmConfig(env);
  const provider = ["openrouter", "omnirouter"].includes(config.provider)
    ? new OpenRouterProvider({
      apiKey: config.apiKey,
      model: config.model,
      fetchImpl,
      baseUrl: env.LLM_BASE_URL ?? (config.provider === "omnirouter" ? "http://localhost:20128/v1" : undefined),
      structuredFallback: config.provider === "omnirouter",
    })
    : new OpenAIResponsesProvider({ apiKey: config.apiKey, model: config.model, fetchImpl, baseUrl: env.LLM_BASE_URL });
  return new LlmAdapter({
    provider,
    policyVersion: config.policyVersion,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    parameters: config.parameters,
    logger,
  });
}
