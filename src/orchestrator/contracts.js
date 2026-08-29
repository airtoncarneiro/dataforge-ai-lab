import { createAdaptiveDecision } from "../adaptive-decision/index.js";
import {
  createAttempt,
  createLearnerState,
  createMasteryChange,
} from "../domain/index.js";
import { createEvaluatorResult } from "../evaluator/index.js";
import {
  createExerciseValidationMetadata,
  createGeneratedExercise,
} from "../exercise/index.js";
import { createProbeSession } from "../probe/index.js";
import { createResultValidation } from "../result-validator/index.js";
import { createLearningFlowState } from "../state-machine/index.js";

export const TERMINAL_APPLICATION_POLICY_VERSION = "terminal-application-policy-v1";

export const TERMINAL_SESSION_STATUSES = Object.freeze([
  "active",
  "ended",
  "error",
]);

export const APPLICATION_EVENT_TYPES = Object.freeze([
  "welcome",
  "session_resumed",
  "probe_question",
  "probe_completed",
  "plan",
  "teach",
  "review",
  "apply",
  "transfer_test",
  "exercise",
  "execution",
  "preview_execution",
  "feedback",
  "socratic_retry",
  "progress",
  "decision",
  "error",
  "session_ended",
]);

export class TutorApplicationValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "TutorApplicationValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TutorApplicationValidationError(code, message);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  return value;
}

function exactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field", `${path}.${key} não é permitido.`);
  }
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_value", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

function timestamp(value, path) {
  const normalized = string(value, path);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    fail("invalid_timestamp", `${path} deve ser timestamp ISO-8601 canônico.`);
  }
  return normalized;
}

function integer(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_value", `${path} deve ser inteiro não negativo.`);
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail("invalid_value", `${path} deve ser um de: ${allowed.join(", ")}.`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function jsonClone(value, path) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError();
    return JSON.parse(serialized);
  } catch {
    fail("invalid_json", `${path} deve ser serializável como JSON.`);
  }
}

function nullable(value, mapper, path) {
  return value === null ? null : mapper(value, path);
}

function array(value, mapper, path) {
  if (!Array.isArray(value)) fail("invalid_shape", `${path} deve ser um array.`);
  return Object.freeze(value.map((item, index) => mapper(item, `${path}[${index}]`)));
}

function createCurrentExercise(input, path) {
  const value = record(input, path);
  exactKeys(value, ["exercise", "validation_metadata"], path);
  return createGeneratedExercise({
    id: value.exercise.id,
    target_concepts: value.exercise.concepts,
    difficulty: value.exercise.difficulty,
    objective: value.exercise.objective,
    statement: value.exercise.statement,
    expected_skills: value.exercise.expected_skills,
    validation_strategy: value.exercise.validation_strategy,
    evaluation_notes: value.exercise.evaluation_notes,
    validation_metadata: value.validation_metadata,
    created_at: value.exercise.created_at,
  }, path);
}

export function createTutorApplicationSession(input, path = "TutorApplicationSession") {
  const value = record(input, path);
  exactKeys(value, [
    "id",
    "learning_goal",
    "status",
    "probe_session",
    "flow_state",
    "learner_state",
    "current_exercise",
    "last_decision",
    "retry_count",
    "attempts",
    "validations",
    "evaluations",
    "mastery_changes",
    "policy_version",
    "created_at",
    "updated_at",
  ], path);
  if (value.policy_version !== TERMINAL_APPLICATION_POLICY_VERSION) {
    fail(
      "invalid_policy_version",
      `${path}.policy_version deve ser ${TERMINAL_APPLICATION_POLICY_VERSION}.`,
    );
  }
  const createdAt = timestamp(value.created_at, `${path}.created_at`);
  const updatedAt = timestamp(value.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) fail("invalid_timestamp", `${path}.updated_at é anterior a created_at.`);
  const status = enumValue(value.status, TERMINAL_SESSION_STATUSES, `${path}.status`);
  const flowState = createLearningFlowState(value.flow_state, `${path}.flow_state`);
  if (flowState.session_id !== value.id) {
    fail("session_mismatch", `${path}.flow_state pertence a outra sessão.`);
  }
  const probeSession = nullable(value.probe_session, createProbeSession, `${path}.probe_session`);
  if (probeSession !== null && probeSession.id !== value.id) {
    fail("session_mismatch", `${path}.probe_session pertence a outra sessão.`);
  }
  const learnerState = nullable(value.learner_state, createLearnerState, `${path}.learner_state`);
  if (learnerState !== null && learnerState.session_id !== value.id) {
    fail("session_mismatch", `${path}.learner_state pertence a outra sessão.`);
  }
  const currentExercise = nullable(
    value.current_exercise,
    createCurrentExercise,
    `${path}.current_exercise`,
  );
  if (
    currentExercise !== null
    && flowState.current_exercise_id !== null
    && currentExercise.exercise.id !== flowState.current_exercise_id
  ) {
    fail("exercise_mismatch", `${path}.current_exercise diverge da State Machine.`);
  }
  if (status === "error" && flowState.status !== "error") {
    fail("status_mismatch", `${path}.status error exige State Machine em error.`);
  }
  if (status === "active" && flowState.status === "error") {
    fail("status_mismatch", `${path}.status active não aceita State Machine em error.`);
  }

  return deepFreeze({
    id: string(value.id, `${path}.id`),
    learning_goal: string(value.learning_goal, `${path}.learning_goal`),
    status,
    probe_session: probeSession,
    flow_state: flowState,
    learner_state: learnerState,
    current_exercise: currentExercise,
    last_decision: nullable(
      value.last_decision,
      createAdaptiveDecision,
      `${path}.last_decision`,
    ),
    retry_count: integer(value.retry_count, `${path}.retry_count`),
    attempts: array(value.attempts, createAttempt, `${path}.attempts`),
    validations: array(
      value.validations,
      createResultValidation,
      `${path}.validations`,
    ),
    evaluations: array(
      value.evaluations,
      createEvaluatorResult,
      `${path}.evaluations`,
    ),
    mastery_changes: array(
      value.mastery_changes,
      createMasteryChange,
      `${path}.mastery_changes`,
    ),
    policy_version: TERMINAL_APPLICATION_POLICY_VERSION,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

const FORBIDDEN_EVENT_KEYS = new Set([
  "referencequery",
  "referencesolution",
  "validationmetadata",
  "trustedvalidationmetadata",
  "instructions",
  "prompt",
  "password",
  "secret",
  "apikey",
  "authorization",
  "connectionstring",
  "databaseurl",
  "stack",
  "stacktrace",
]);

const SENSITIVE_PATTERNS = Object.freeze([
  /postgres(?:ql)?:\/\/[^\s]+/iu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/iu,
]);

function assertSafeEvent(value, path = "ApplicationEvent.data") {
  if (typeof value === "string") {
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail("sensitive_output", `${path} contém dado sensível.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvent(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
      if (FORBIDDEN_EVENT_KEYS.has(normalized)) {
        fail("sensitive_output", `${path}.${key} não pode ser exibido.`);
      }
      assertSafeEvent(item, `${path}.${key}`);
    }
  }
}

export function createApplicationEvent(type, data) {
  const eventType = enumValue(type, APPLICATION_EVENT_TYPES, "ApplicationEvent.type");
  const cloned = jsonClone(data, "ApplicationEvent.data");
  assertSafeEvent(cloned);
  return deepFreeze({ type: eventType, data: cloned });
}

export function createApplicationResult(session, events) {
  if (!Array.isArray(events)) fail("invalid_shape", "ApplicationResult.events deve ser array.");
  const normalized = createTutorApplicationSession(session);
  return deepFreeze({
    session: {
      id: normalized.id,
      learning_goal: normalized.learning_goal,
      status: normalized.status,
      phase: normalized.flow_state.phase,
      flow_status: normalized.flow_state.status,
      current_concept: normalized.flow_state.current_concept,
      current_exercise_id: normalized.flow_state.current_exercise_id,
      question_count: normalized.probe_session?.question_count ?? 0,
      attempt_count: normalized.attempts.length,
      retry_count: normalized.retry_count,
      last_action: normalized.last_decision?.action ?? null,
      policy_version: normalized.policy_version,
      updated_at: normalized.updated_at,
    },
    events: Object.freeze(events.map((event, index) => {
      const value = record(event, `ApplicationResult.events[${index}]`);
      exactKeys(value, ["type", "data"], `ApplicationResult.events[${index}]`);
      return createApplicationEvent(value.type, value.data);
    })),
  });
}

export function createTrustedCurrentExercise(exercise, validationMetadata) {
  return createCurrentExercise({
    exercise,
    validation_metadata: createExerciseValidationMetadata(validationMetadata),
  }, "TrustedCurrentExercise");
}
