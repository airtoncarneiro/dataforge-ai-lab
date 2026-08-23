import { createLearnerState } from "../domain/index.js";

const SUPPORTED_PHASES = Object.freeze(["PLAN", "TEACH"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} deve ser uma string não vazia.`);
  }
  return value;
}

function publicError(error) {
  return deepFreeze({
    category: typeof error?.category === "string" ? error.category : "provider_error",
    code: typeof error?.code === "string" ? error.code : "phase_generation_failed",
    message: "O conteúdo pedagógico desta fase não pôde ser gerado.",
    retryable: Boolean(error?.retryable),
  });
}

export class TutorPhaseService {
  #adapter;
  #policyBuilder;
  #knowledgeGraph;

  constructor({ adapter, policyBuilder, knowledgeGraph }) {
    if (!adapter || typeof adapter.generate !== "function") {
      throw new TypeError("TutorPhaseService requer o LLM Adapter B11.");
    }
    if (!policyBuilder || typeof policyBuilder.build !== "function") {
      throw new TypeError("TutorPhaseService requer o context builder B12.");
    }
    if (!knowledgeGraph || typeof knowledgeGraph.getConcept !== "function") {
      throw new TypeError("TutorPhaseService requer o Knowledge Graph B09.");
    }
    this.#adapter = adapter;
    this.#policyBuilder = policyBuilder;
    this.#knowledgeGraph = knowledgeGraph;
  }

  async plan(input) {
    return this.#generate("PLAN", input);
  }

  async teach(input) {
    return this.#generate("TEACH", input);
  }

  async #generate(phase, input) {
    if (!SUPPORTED_PHASES.includes(phase)) throw new TypeError("Fase não suportada.");
    const learningGoal = string(input.learningGoal, "learningGoal");
    const currentConcept = string(input.currentConcept, "currentConcept");
    this.#knowledgeGraph.getConcept(currentConcept);
    const learnerState = createLearnerState(input.learnerState);
    const request = this.#policyBuilder.build({
      phase,
      learningGoal,
      relevantConcepts: [currentConcept],
      learnerState,
      knowledgeGraph: this.#knowledgeGraph,
      recentMessages: input.recentMessages ?? [],
      tools: [],
    });
    let response;
    try {
      response = await this.#adapter.generate(request);
    } catch {
      return deepFreeze({
        status: "error",
        phase,
        output: null,
        error: publicError(null),
      });
    }
    if (response.status !== "ok") {
      return deepFreeze({
        status: "error",
        phase,
        output: null,
        error: publicError(response.error),
      });
    }
    return deepFreeze({
      status: "ok",
      phase,
      output: response.output,
      error: null,
    });
  }
}
