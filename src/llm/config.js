import { LlmAdapter } from "./llm-adapter.js";
import { LlmConfigurationError } from "./errors.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses-provider.js";
import { OpenAICompatibleProvider } from "./providers/openrouter-provider.js";

const PROVIDER_PROFILES = Object.freeze({
  openai: Object.freeze({ protocol: "responses", apiKeyVariable: "OPENAI_API_KEY" }),
  openrouter: Object.freeze({
    protocol: "chat-completions",
    apiKeyVariable: "OPENROUTER_API_KEY",
    supportsProviderRouting: true,
    supportsResponseHealing: true,
  }),
  omnirouter: Object.freeze({
    protocol: "chat-completions",
    apiKeyVariable: "OMNIROUTER_API_KEY",
    baseUrl: "http://localhost:20128/v1",
    allowStructuredFallback: true,
  }),
});

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

function optionalBoolean(value, variableName, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  if (["true", "1"].includes(value.trim().toLowerCase())) return true;
  if (["false", "0"].includes(value.trim().toLowerCase())) return false;
  throw new LlmConfigurationError(
    `invalid_${variableName.toLowerCase()}`,
    `${variableName} must be true or false.`,
  );
}

function providerPreferencesFromEnv(env) {
  const order = (env.OPENROUTER_PROVIDER_ORDER ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  return Object.freeze({
    ...(order.length > 0 ? { order } : {}),
    allow_fallbacks: optionalBoolean(env.OPENROUTER_ALLOW_FALLBACKS, "OPENROUTER_ALLOW_FALLBACKS", true),
  });
}

function loadLlmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER ?? "openai").trim().toLowerCase();
  const profile = PROVIDER_PROFILES[provider];
  if (!profile) {
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
    protocol: profile.protocol,
    apiKey: required(
      env[profile.apiKeyVariable]
        ?? (provider === "omnirouter" ? env.OPENROUTER_API_KEY : undefined)
        ?? (provider !== "openai" ? env.OPENAI_API_KEY : undefined),
      profile.apiKeyVariable,
    ),
    model: required(env.OPENAI_MODEL, "OPENAI_MODEL"),
    policyVersion: required(env.LLM_POLICY_VERSION, "LLM_POLICY_VERSION"),
    timeoutMs: integer(env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS", 30_000, { min: 1 }),
    maxRetries: integer(env.LLM_MAX_RETRIES, "LLM_MAX_RETRIES", 1),
    parameters: Object.freeze(parameters),
    providerPreferences: profile.supportsProviderRouting ? providerPreferencesFromEnv(env) : Object.freeze({}),
    responseHealing: profile.supportsResponseHealing
      ? optionalBoolean(env.OPENROUTER_RESPONSE_HEALING, "OPENROUTER_RESPONSE_HEALING", true)
      : false,
    capabilities: Object.freeze({
      allowStructuredFallback: profile.allowStructuredFallback === true,
      supportsProviderRouting: profile.supportsProviderRouting === true,
      supportsResponseHealing: profile.supportsResponseHealing === true,
    }),
    baseUrl: env.LLM_BASE_URL ?? profile.baseUrl,
  });
}

export function createLlmAdapterFromEnv(
  env = process.env,
  { fetchImpl = globalThis.fetch, logger } = {},
) {
  const config = loadLlmConfig(env);
  const provider = config.protocol === "chat-completions"
    ? new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      model: config.model,
      fetchImpl,
      baseUrl: config.baseUrl,
      structuredFallback: config.capabilities.allowStructuredFallback,
      providerPreferences: config.capabilities.supportsProviderRouting ? config.providerPreferences : {},
      responseHealing: config.capabilities.supportsResponseHealing && config.responseHealing,
      providerName: config.provider,
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
