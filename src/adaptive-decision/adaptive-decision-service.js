import {
  DomainValidationError,
  createEvaluation,
  createLearnerState,
} from "../domain/index.js";
import { KnowledgeGraph } from "../knowledge-graph/index.js";

export const ADAPTIVE_POLICY_VERSION = "adaptive-policy-v1";
export const MAX_CONSECUTIVE_RETRIES = 2;

export const ADAPTIVE_ACTIONS = Object.freeze([
  "retry",
  "reteach",
  "practice",
  "advance",
  "review",
]);

export const ADAPTIVE_REASON_CODES = Object.freeze([
  "isolated_execution_error",
  "retry_limit_reached",
  "conceptual_error",
  "confirmed_misconception",
  "suspected_misconception",
  "mastery_insufficient",
  "mastery_partial",
  "confidence_insufficient",
  "operational_mastery",
  "prerequisites_satisfied",
  "blocked_prerequisites",
  "no_available_concept",
]);

const GAP_REASONS = Object.freeze([
  "missing_state",
  "mastery_below_threshold",
  "confidence_low",
]);

export class MissingConceptStateError extends Error {
  constructor(concept) {
    super(`LearnerState não contém estado para o conceito atual: ${concept}.`);
    this.name = "MissingConceptStateError";
    this.concept = concept;
  }
}

function fail(path, message) {
  throw new DomainValidationError(path, message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "deve ser um objeto JSON simples");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "deve ser um objeto JSON simples");
  }
  return value;
}

function assertExactKeys(value, allowedKeys, path) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "campo desconhecido");
    }
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "deve ser uma string não vazia");
  }
  return value;
}

function nullableConcept(value, path) {
  return value === null ? null : requiredString(value, path);
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(path, `deve ser um de: ${allowed.join(", ")}`);
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "deve ser um inteiro não negativo");
  }
  return value;
}

function nullableMastery(value, path) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(path, "deve ser null ou um número entre 0 e 1");
  }
  return value;
}

function nullableConfidence(value, path) {
  if (value === null) {
    return null;
  }
  return enumValue(value, ["low", "medium", "high"], path);
}

function createBlockingPrerequisite(input, path) {
  const value = assertRecord(input, path);
  assertExactKeys(
    value,
    ["target_concept", "concept", "reason", "mastery", "confidence"],
    path,
  );
  return Object.freeze({
    target_concept: requiredString(value.target_concept, `${path}.target_concept`),
    concept: requiredString(value.concept, `${path}.concept`),
    reason: enumValue(value.reason, GAP_REASONS, `${path}.reason`),
    mastery: nullableMastery(value.mastery, `${path}.mastery`),
    confidence: nullableConfidence(value.confidence, `${path}.confidence`),
  });
}

export function createAdaptiveDecision(input, path = "AdaptiveDecision") {
  const value = assertRecord(input, path);
  assertExactKeys(value, [
    "action",
    "current_concept",
    "next_concept",
    "reason_codes",
    "rationale",
    "blocking_prerequisites",
    "policy_version",
  ], path);

  if (!Array.isArray(value.reason_codes) || value.reason_codes.length === 0) {
    fail(`${path}.reason_codes`, "deve ser um array não vazio");
  }
  const reasonCodes = value.reason_codes.map((reason, index) => enumValue(
    reason,
    ADAPTIVE_REASON_CODES,
    `${path}.reason_codes[${index}]`,
  ));
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    fail(`${path}.reason_codes`, "não deve conter valores duplicados");
  }
  if (!Array.isArray(value.blocking_prerequisites)) {
    fail(`${path}.blocking_prerequisites`, "deve ser um array");
  }
  const blockingPrerequisites = value.blocking_prerequisites.map(
    (item, index) => createBlockingPrerequisite(
      item,
      `${path}.blocking_prerequisites[${index}]`,
    ),
  );
  if (blockingPrerequisites.length > 0 && !reasonCodes.includes("blocked_prerequisites")) {
    fail(
      `${path}.reason_codes`,
      "deve incluir blocked_prerequisites quando houver bloqueios",
    );
  }

  const action = enumValue(value.action, ADAPTIVE_ACTIONS, `${path}.action`);
  const nextConcept = nullableConcept(value.next_concept, `${path}.next_concept`);
  if ((action === "advance") !== (nextConcept !== null)) {
    fail(`${path}.next_concept`, "deve existir somente quando action for advance");
  }
  if (value.policy_version !== ADAPTIVE_POLICY_VERSION) {
    fail(`${path}.policy_version`, `deve ser ${ADAPTIVE_POLICY_VERSION}`);
  }

  return Object.freeze({
    action,
    current_concept: requiredString(value.current_concept, `${path}.current_concept`),
    next_concept: nextConcept,
    reason_codes: Object.freeze(reasonCodes),
    rationale: requiredString(value.rationale, `${path}.rationale`),
    blocking_prerequisites: Object.freeze(blockingPrerequisites),
    policy_version: ADAPTIVE_POLICY_VERSION,
  });
}

function blockingPrerequisitesFor(graph, learnerState, targetConcept) {
  return graph.getPrerequisiteGaps(targetConcept, learnerState).map((gap) => ({
    target_concept: targetConcept,
    concept: gap.concept,
    reason: gap.reason,
    mastery: gap.mastery,
    confidence: gap.confidence,
  }));
}

function directBlockingPrerequisites(graph, learnerState, currentConcept) {
  const blockedIds = new Set(graph.getBlockedConcepts(learnerState).map((item) => item.id));
  return graph
    .getDirectDependents(currentConcept)
    .filter((dependent) => blockedIds.has(dependent.id))
    .flatMap((dependent) => blockingPrerequisitesFor(
      graph,
      learnerState,
      dependent.id,
    ));
}

function decision({
  action,
  currentConcept,
  nextConcept = null,
  reasonCodes,
  rationale,
  blockingPrerequisites = [],
}) {
  const normalizedReasonCodes = blockingPrerequisites.length > 0
    && !reasonCodes.includes("blocked_prerequisites")
    ? [...reasonCodes, "blocked_prerequisites"]
    : reasonCodes;
  return createAdaptiveDecision({
    action,
    current_concept: currentConcept,
    next_concept: nextConcept,
    reason_codes: normalizedReasonCodes,
    rationale,
    blocking_prerequisites: blockingPrerequisites,
    policy_version: ADAPTIVE_POLICY_VERSION,
  });
}

function fallbackAfterRetryLimit(currentConcept, currentState, graph, learnerState) {
  const blockingPrerequisites = blockingPrerequisitesFor(
    graph,
    learnerState,
    currentConcept,
  );
  if (currentState.mastery < 0.5) {
    return decision({
      action: "reteach",
      currentConcept,
      reasonCodes: ["retry_limit_reached", "mastery_insufficient"],
      rationale: "O limite de retries técnicos foi atingido e o domínio atual é insuficiente.",
      blockingPrerequisites,
    });
  }
  return decision({
    action: "practice",
    currentConcept,
    reasonCodes: ["retry_limit_reached"],
    rationale: "O limite de retries técnicos foi atingido; uma prática diferente evita repetição indefinida.",
    blockingPrerequisites,
  });
}

function misconceptionSeverity(currentState, evaluation) {
  const active = [
    ...currentState.misconceptions,
    ...evaluation.assessment.misconceptions.filter(
      (item) => item.concept === currentState.concept,
    ),
  ].filter((item) => item.status !== "resolved");

  if (active.some((item) => item.status === "confirmed")) {
    return "confirmed";
  }
  if (active.some((item) => item.status === "suspected")) {
    return "suspected";
  }
  return null;
}

function chooseAdvanceCandidate(graph, learnerState, currentConcept) {
  const available = graph.getAvailableConcepts(learnerState);
  const availableIds = new Set(available.map((item) => item.id));
  const directCandidate = graph
    .getDirectDependents(currentConcept)
    .find((item) => availableIds.has(item.id));
  return directCandidate ?? available.find((item) => item.id !== currentConcept) ?? null;
}

export function decideNextAction(input) {
  const value = assertRecord(input, "AdaptiveDecisionInput");
  assertExactKeys(value, [
    "learner_state",
    "evaluation",
    "knowledge_graph",
    "current_concept",
    "retry_count",
  ], "AdaptiveDecisionInput");

  const learnerState = createLearnerState(value.learner_state);
  const evaluation = createEvaluation(value.evaluation);
  const currentConcept = requiredString(
    value.current_concept,
    "AdaptiveDecisionInput.current_concept",
  );
  const retryCount = nonNegativeInteger(
    value.retry_count === undefined ? 0 : value.retry_count,
    "AdaptiveDecisionInput.retry_count",
  );
  if (!(value.knowledge_graph instanceof KnowledgeGraph)) {
    fail("AdaptiveDecisionInput.knowledge_graph", "deve ser uma instância de KnowledgeGraph");
  }
  const graph = value.knowledge_graph;
  graph.getConcept(currentConcept);

  const currentState = learnerState.concepts.find(
    (item) => item.concept === currentConcept,
  );
  if (!currentState) {
    throw new MissingConceptStateError(currentConcept);
  }

  const severity = misconceptionSeverity(currentState, evaluation);
  const hasConceptualError = evaluation.assessment.conceptual_errors.length > 0;
  const executionError = evaluation.assessment.execution_error;
  const isolatedExecutionError = executionError !== null
    && !hasConceptualError
    && severity === null;
  const currentBlocking = blockingPrerequisitesFor(graph, learnerState, currentConcept);

  if (isolatedExecutionError) {
    if (retryCount < MAX_CONSECUTIVE_RETRIES) {
      return decision({
        action: "retry",
        currentConcept,
        reasonCodes: ["isolated_execution_error"],
        rationale: `Erro técnico isolado (${executionError.category}); retry ${retryCount + 1}/${MAX_CONSECUTIVE_RETRIES}.`,
        blockingPrerequisites: currentBlocking,
      });
    }
    return fallbackAfterRetryLimit(currentConcept, currentState, graph, learnerState);
  }

  if (severity === "confirmed") {
    return decision({
      action: "reteach",
      currentConcept,
      reasonCodes: ["confirmed_misconception"],
      rationale: "Há misconception confirmada ativa no conceito atual.",
      blockingPrerequisites: currentBlocking,
    });
  }

  if (hasConceptualError) {
    const insufficient = currentState.mastery < 0.5;
    const reasonCodes = ["conceptual_error"];
    if (insufficient) {
      reasonCodes.push("mastery_insufficient");
    } else if (currentState.mastery < 0.8) {
      reasonCodes.push("mastery_partial");
    }
    return decision({
      action: insufficient ? "reteach" : "practice",
      currentConcept,
      reasonCodes,
      rationale: insufficient
        ? "A avaliação registra erro conceitual e domínio insuficiente."
        : "A avaliação registra erro conceitual; prática adicional é necessária.",
      blockingPrerequisites: currentBlocking,
    });
  }

  if (severity === "suspected") {
    const insufficient = currentState.mastery < 0.5;
    return decision({
      action: insufficient ? "reteach" : "practice",
      currentConcept,
      reasonCodes: [
        "suspected_misconception",
        ...(insufficient ? ["mastery_insufficient"] : []),
      ],
      rationale: insufficient
        ? "Há misconception suspeita ativa e o domínio atual é insuficiente."
        : "Há misconception suspeita ativa; prática direcionada deve produzir nova evidência.",
      blockingPrerequisites: currentBlocking,
    });
  }

  if (currentState.mastery < 0.5) {
    return decision({
      action: "reteach",
      currentConcept,
      reasonCodes: ["mastery_insufficient"],
      rationale: `Mastery ${currentState.mastery.toFixed(3)} está abaixo de 0.500.`,
      blockingPrerequisites: currentBlocking,
    });
  }

  if (currentState.mastery < 0.8) {
    return decision({
      action: "practice",
      currentConcept,
      reasonCodes: ["mastery_partial"],
      rationale: `Mastery ${currentState.mastery.toFixed(3)} está entre 0.500 e 0.799.`,
      blockingPrerequisites: currentBlocking,
    });
  }

  if (!graph.isOperationallyMastered(currentConcept, learnerState)) {
    return decision({
      action: "practice",
      currentConcept,
      reasonCodes: ["confidence_insufficient"],
      rationale: "Mastery atingiu 0.800, mas confidence low ainda não permite avanço.",
      blockingPrerequisites: currentBlocking,
    });
  }

  const nextConcept = chooseAdvanceCandidate(graph, learnerState, currentConcept);
  const directBlocking = directBlockingPrerequisites(graph, learnerState, currentConcept);
  if (nextConcept) {
    return decision({
      action: "advance",
      currentConcept,
      nextConcept: nextConcept.id,
      reasonCodes: ["operational_mastery", "prerequisites_satisfied"],
      rationale: `Domínio operacional confirmado; ${nextConcept.id} é o primeiro candidato disponível pela ordem do grafo.`,
      blockingPrerequisites: directBlocking,
    });
  }

  return decision({
    action: "review",
    currentConcept,
    reasonCodes: [
      "operational_mastery",
      ...(directBlocking.length > 0 ? ["blocked_prerequisites"] : []),
      "no_available_concept",
    ],
    rationale: "Domínio operacional confirmado, mas não há conceito disponível para avanço.",
    blockingPrerequisites: directBlocking,
  });
}

export class AdaptiveDecisionService {
  decide(input) {
    return decideNextAction(input);
  }
}
