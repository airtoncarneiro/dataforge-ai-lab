import { LlmConfigurationError, LlmProviderError } from "../errors.js";

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

export class FakeLlmProvider {
  #model;
  #scenarios;
  #calls = [];

  constructor({ model = "fake-model", scenario, scenarios } = {}) {
    const configured = scenarios ?? (scenario ? [scenario] : []);
    if (!Array.isArray(configured) || configured.length === 0) {
      throw new LlmConfigurationError(
        "missing_fake_scenario",
        "The fake LLM provider requires at least one deterministic scenario.",
      );
    }
    this.#model = model;
    this.#scenarios = clone(configured);
  }

  get name() {
    return "fake";
  }

  get model() {
    return this.#model;
  }

  get callCount() {
    return this.#calls.length;
  }

  get calls() {
    return clone(this.#calls);
  }

  async generate(request) {
    const { signal, ...publicRequest } = request;
    this.#calls.push(clone(publicRequest));
    const index = Math.min(this.#calls.length - 1, this.#scenarios.length - 1);
    const scenario = this.#scenarios[index];

    switch (scenario.type) {
      case "valid":
      case "output":
        return {
          type: "output",
          output: clone(scenario.output),
          toolCalls: clone(scenario.toolCalls ?? []),
          requestId: scenario.requestId ?? `fake-request-${this.#calls.length}`,
          usage: clone(scenario.usage ?? null),
        };
      case "invalid":
        return {
          type: "output",
          output: scenario.output ?? "{invalid-json",
          toolCalls: [],
          requestId: `fake-request-${this.#calls.length}`,
          usage: null,
        };
      case "timeout":
        return waitForAbort(signal);
      case "provider_error":
        throw new LlmProviderError({
          category: "provider_error",
          code: "fake_provider_error",
          message: "The LLM provider could not complete the request.",
          retryable: scenario.retryable ?? false,
        });
      case "authentication_error":
        throw new LlmProviderError({
          category: "authentication_error",
          code: "provider_authentication_failed",
          message: "The LLM provider rejected its configured credentials.",
        });
      case "refusal":
        return { type: "refusal", requestId: `fake-request-${this.#calls.length}` };
      default:
        throw new LlmProviderError({
          category: "invalid_response",
          code: "unknown_fake_scenario",
          message: "The fake LLM provider scenario is invalid.",
        });
    }
  }
}
