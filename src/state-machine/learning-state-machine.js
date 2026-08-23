import {
  ADAPTIVE_POLICY_VERSION,
  MAX_CONSECUTIVE_RETRIES,
  createAdaptiveDecision,
} from "../adaptive-decision/index.js";
import {
  PROBE_POLICY_VERSION,
  createProbeSession,
} from "../probe/index.js";
import {
  createLearningFlowError,
  createLearningFlowState,
  createLearningFlowTransition,
  LearningFlowValidationError,
} from "./contracts.js";
import {
  ADAPTIVE_EVENT_BY_ACTION,
  ADAPTIVE_FLOW_EVENTS,
  findLearningFlowTransition,
  LEARNING_FLOW_EVENTS,
  LEARNING_FLOW_EVENT_VERSION,
  LEARNING_FLOW_POLICY_VERSION,
} from "./state-machine-policy.js";

const PAYLOAD_KEYS = new Set([
  "reason",
  "timestamp",
  "probe_session",
  "current_concept",
  "exercise_id",
  "evaluation_id",
  "readiness",
  "completion",
  "error",
  "adaptive_decision",
]);

export class UnknownLearningFlowEventError extends Error {
  constructor(event) {
    super(`Evento desconhecido da State Machine: ${event}.`);
    this.name = "UnknownLearningFlowEventError";
    this.event = event;
  }
}

export class InvalidLearningFlowTransitionError extends Error {
  constructor({ phase, status, event }) {
    super(`Transição inválida: ${phase}/${status} não aceita ${event}.`);
    this.name = "InvalidLearningFlowTransitionError";
    this.phase = phase;
    this.status = status;
    this.event = event;
  }
}

export class LearningFlowGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LearningFlowGuardError";
    this.code = code;
  }
}

function guard(code, message) {
  throw new LearningFlowGuardError(code, message);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LearningFlowValidationError("invalid_shape", `${path} deve ser um objeto.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LearningFlowValidationError("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  return value;
}

function payload(input) {
  const value = record(input ?? {}, "LearningFlowTransitionPayload");
  for (const key of Object.keys(value)) {
    if (!PAYLOAD_KEYS.has(key)) {
      throw new LearningFlowValidationError(
        "unknown_field",
        `LearningFlowTransitionPayload.${key} não é permitido.`,
      );
    }
  }
  return value;
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LearningFlowValidationError("invalid_value", `${path} deve ser string não vazia.`);
  }
  return value;
}

function timestamp(value, path) {
  const normalized = string(value, path);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new LearningFlowValidationError(
      "invalid_timestamp",
      `${path} deve ser timestamp ISO-8601 canônico.`,
    );
  }
  return normalized;
}

function stringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LearningFlowValidationError(
      "invalid_value",
      `${path} deve conter ao menos uma evidência.`,
    );
  }
  const normalized = value.map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new LearningFlowValidationError("invalid_value", `${path} contém duplicatas.`);
  }
  return normalized;
}

function readiness(input, expectedKind) {
  const value = record(input, "readiness");
  const allowed = new Set(["kind", "satisfied", "evidence_ids", "policy_version"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LearningFlowValidationError("unknown_field", "readiness contém campo desconhecido.");
  }
  if (value.kind !== expectedKind || value.satisfied !== true) {
    guard("readiness_not_satisfied", `Readiness de ${expectedKind} não foi satisfeita.`);
  }
  return Object.freeze({
    kind: expectedKind,
    satisfied: true,
    evidence_ids: Object.freeze(stringArray(value.evidence_ids, "readiness.evidence_ids")),
    policy_version: string(value.policy_version, "readiness.policy_version"),
  });
}

function completion(input) {
  const value = record(input, "completion");
  const allowed = new Set([
    "satisfied",
    "apply_verified",
    "transfer_verified",
    "evidence_ids",
    "policy_version",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LearningFlowValidationError("unknown_field", "completion contém campo desconhecido.");
  }
  if (value.satisfied !== true || value.apply_verified !== true || value.transfer_verified !== true) {
    guard("completion_not_satisfied", "Os critérios de conclusão não foram satisfeitos.");
  }
  return Object.freeze({
    evidence_ids: Object.freeze(stringArray(value.evidence_ids, "completion.evidence_ids")),
    policy_version: string(value.policy_version, "completion.policy_version"),
  });
}

function hasEvaluatedApplyCycle(state) {
  const applyIndex = state.transition_history.findLastIndex(
    (entry) => entry.event === "apply_completed",
  );
  if (applyIndex < 0) {
    return false;
  }
  return state.transition_history.slice(applyIndex + 1).some(
    (entry) => entry.event === "evaluation_completed",
  );
}

function retryCount(state) {
  let count = 0;
  for (const entry of [...state.transition_history].reverse()) {
    if (!ADAPTIVE_FLOW_EVENTS.includes(entry.event)) {
      continue;
    }
    if (entry.event !== "retry_requested") {
      break;
    }
    if (
      entry.current_concept === state.current_concept
      && entry.current_exercise_id === state.current_exercise_id
    ) {
      count += 1;
    }
  }
  return count;
}

function probeConcept(probe, requestedConcept) {
  const concept = requestedConcept ?? probe.result.next_concept_recommended;
  if (typeof concept !== "string" || !probe.target_concepts.includes(concept)) {
    guard(
      "missing_probe_concept",
      "O PROBE concluído deve fornecer um próximo conceito pertencente ao diagnóstico.",
    );
  }
  return concept;
}

function adaptiveEffects(state, event, input) {
  const decision = createAdaptiveDecision(input);
  const expectedEvent = ADAPTIVE_EVENT_BY_ACTION[decision.action];
  if (expectedEvent !== event) {
    guard("adaptive_event_mismatch", "O evento não corresponde à decisão de B10.");
  }
  if (decision.policy_version !== ADAPTIVE_POLICY_VERSION) {
    guard("adaptive_policy_mismatch", "A decisão não usa a versão de política B10 esperada.");
  }
  if (decision.current_concept !== state.current_concept) {
    guard("adaptive_concept_mismatch", "A decisão B10 não corresponde ao conceito atual.");
  }
  if (event === "retry_requested" && retryCount(state) >= MAX_CONSECUTIVE_RETRIES) {
    guard("retry_limit_reached", "A State Machine recusou um novo retry além do limite de B10.");
  }
  return {
    decision,
    currentConcept: decision.next_concept ?? decision.current_concept,
    currentExerciseId: event === "retry_requested" ? state.current_exercise_id : null,
    sourcePolicyVersion: decision.policy_version,
  };
}

function eventEffects(state, event, input) {
  let currentConcept = state.current_concept;
  let currentExerciseId = state.current_exercise_id;
  let status = "active";
  let error = null;
  let sourcePolicyVersion = null;

  switch (event) {
    case "probe_completed": {
      const probe = createProbeSession(input.probe_session);
      if (probe.id !== state.session_id) {
        guard("probe_session_mismatch", "A ProbeSession pertence a outra sessão.");
      }
      if (probe.status !== "completed") {
        guard("probe_not_completed", "Somente um PROBE concluído pode avançar para PLAN.");
      }
      if (probe.policy_version !== PROBE_POLICY_VERSION) {
        guard("probe_policy_mismatch", "A ProbeSession usa uma policy incompatível.");
      }
      currentConcept = probeConcept(probe, input.current_concept);
      currentExerciseId = null;
      sourcePolicyVersion = probe.policy_version;
      break;
    }
    case "plan_ready":
    case "teaching_completed":
      if (currentConcept === null) {
        guard("missing_current_concept", `${event} exige current_concept.`);
      }
      currentExerciseId = null;
      break;
    case "exercise_ready": {
      const exerciseId = string(input.exercise_id, "exercise_id");
      if (exerciseId === currentExerciseId) {
        guard("duplicate_exercise", "O exercício já está ativo nesta fase.");
      }
      currentExerciseId = exerciseId;
      break;
    }
    case "answer_submitted":
      if (currentExerciseId === null) {
        guard("missing_exercise", "answer_submitted exige exercício atual.");
      }
      if (input.exercise_id !== undefined && input.exercise_id !== currentExerciseId) {
        guard("exercise_mismatch", "A resposta referencia outro exercício.");
      }
      break;
    case "evaluation_completed":
      string(input.evaluation_id, "evaluation_id");
      break;
    case "retry_requested":
    case "reteach_requested":
    case "practice_requested":
    case "advance_requested":
    case "review_requested": {
      const adaptive = adaptiveEffects(state, event, input.adaptive_decision);
      currentConcept = adaptive.currentConcept;
      currentExerciseId = adaptive.currentExerciseId;
      sourcePolicyVersion = adaptive.sourcePolicyVersion;
      break;
    }
    case "review_completed":
      if (currentConcept === null) {
        guard("missing_current_concept", "review_completed exige current_concept.");
      }
      currentExerciseId = null;
      break;
    case "apply_ready": {
      const guardResult = readiness(input.readiness, "apply");
      currentExerciseId = string(input.exercise_id, "exercise_id");
      sourcePolicyVersion = guardResult.policy_version;
      break;
    }
    case "apply_completed":
      if (currentExerciseId === null) {
        guard("missing_exercise", "apply_completed exige atividade APPLY atual.");
      }
      break;
    case "transfer_test_ready": {
      if (!hasEvaluatedApplyCycle(state)) {
        guard("apply_not_verified", "TRANSFER_TEST exige ciclo APPLY avaliado.");
      }
      const guardResult = readiness(input.readiness, "transfer_test");
      currentExerciseId = string(input.exercise_id, "exercise_id");
      sourcePolicyVersion = guardResult.policy_version;
      break;
    }
    case "transfer_test_completed":
      if (currentExerciseId === null) {
        guard("missing_exercise", "transfer_test_completed exige atividade atual.");
      }
      break;
    case "learning_completed": {
      if (state.transition_history.at(-1)?.event !== "transfer_test_completed") {
        guard(
          "transfer_not_evaluated",
          "Conclusão exige EVALUATE imediatamente após TRANSFER_TEST.",
        );
      }
      const guardResult = completion(input.completion);
      currentExerciseId = null;
      status = "completed";
      sourcePolicyVersion = guardResult.policy_version;
      break;
    }
    case "failure":
      error = createLearningFlowError(input.error);
      status = "error";
      break;
    case "resume_requested":
      if (!state.error.retryable) {
        guard("failure_not_retryable", "A falha atual não permite retomada automática.");
      }
      break;
    default:
      throw new UnknownLearningFlowEventError(event);
  }

  return { currentConcept, currentExerciseId, status, error, sourcePolicyVersion };
}

function defaultClock() {
  return new Date().toISOString();
}

export class LearningStateMachine {
  #clock;

  constructor({ clock = defaultClock } = {}) {
    if (typeof clock !== "function") {
      throw new TypeError("LearningStateMachine.clock deve ser uma função.");
    }
    this.#clock = clock;
  }

  create({ sessionId, currentConcept = null, createdAt } = {}) {
    const now = timestamp(createdAt ?? this.#clock(), "createdAt");
    return createLearningFlowState({
      session_id: string(sessionId, "sessionId"),
      phase: "PROBE",
      status: "active",
      transition_sequence: 0,
      transition_history: [],
      current_concept: currentConcept,
      current_exercise_id: null,
      last_event: null,
      error: null,
      policy_version: LEARNING_FLOW_POLICY_VERSION,
      created_at: now,
      updated_at: now,
    });
  }

  transition(stateInput, event, transitionPayload = {}) {
    const state = createLearningFlowState(stateInput);
    if (!LEARNING_FLOW_EVENTS.includes(event)) {
      throw new UnknownLearningFlowEventError(event);
    }
    const rule = findLearningFlowTransition(state.phase, state.status, event);
    if (!rule) {
      throw new InvalidLearningFlowTransitionError({
        phase: state.phase,
        status: state.status,
        event,
      });
    }
    const input = payload(transitionPayload);
    const reason = string(input.reason, "reason");
    const occurredAt = timestamp(input.timestamp ?? this.#clock(), "timestamp");
    if (occurredAt < state.updated_at) {
      guard("non_monotonic_timestamp", "A transição não pode anteceder o estado atual.");
    }
    const effects = eventEffects(state, event, input);
    const phase = event === "learning_completed" ? "COMPLETED" : rule.to;
    const sequence = state.transition_sequence + 1;
    const transition = createLearningFlowTransition({
      from: state.phase,
      to: phase,
      from_status: state.status,
      to_status: effects.status,
      event,
      reason,
      timestamp: occurredAt,
      sequence,
      policy_version: LEARNING_FLOW_POLICY_VERSION,
      event_version: LEARNING_FLOW_EVENT_VERSION,
      source_policy_version: effects.sourcePolicyVersion,
      current_concept: effects.currentConcept,
      current_exercise_id: effects.currentExerciseId,
    });

    return createLearningFlowState({
      session_id: state.session_id,
      phase,
      status: effects.status,
      transition_sequence: sequence,
      transition_history: [...state.transition_history, transition],
      current_concept: effects.currentConcept,
      current_exercise_id: effects.currentExerciseId,
      last_event: event,
      error: effects.error,
      policy_version: LEARNING_FLOW_POLICY_VERSION,
      created_at: state.created_at,
      updated_at: occurredAt,
    });
  }

  applyAdaptiveDecision(state, decisionInput, { timestamp: at } = {}) {
    const decision = createAdaptiveDecision(decisionInput);
    return this.transition(state, ADAPTIVE_EVENT_BY_ACTION[decision.action], {
      reason: decision.rationale,
      timestamp: at,
      adaptive_decision: decision,
    });
  }

  applyProbeSession(stateInput, probeInput, { timestamp: at, currentConcept } = {}) {
    const state = createLearningFlowState(stateInput);
    const probe = createProbeSession(probeInput);
    if (probe.id !== state.session_id) {
      guard("probe_session_mismatch", "A ProbeSession pertence a outra sessão.");
    }
    if (probe.status === "completed") {
      return this.transition(state, "probe_completed", {
        reason: `PROBE concluído: ${probe.completion_reason}.`,
        timestamp: at,
        probe_session: probe,
        current_concept: currentConcept,
      });
    }
    if (probe.status === "error") {
      const retryable = ["timeout", "provider_error"].includes(probe.error.category);
      return this.transition(state, "failure", {
        reason: "Falha explícita do PROBE; a fase foi preservada.",
        timestamp: at,
        error: {
          code: probe.error.code,
          message: "O diagnóstico não pôde ser concluído.",
          retryable,
          failed_event: "probe_completed",
        },
      });
    }
    guard("probe_still_active", "Uma ProbeSession ativa não pode alterar a fase.");
  }
}
