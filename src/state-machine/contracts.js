import {
  findLearningFlowTransition,
  LEARNING_FLOW_EVENTS,
  LEARNING_FLOW_EVENT_VERSION,
  LEARNING_FLOW_PHASES,
  LEARNING_FLOW_POLICY_VERSION,
  LEARNING_FLOW_STATUSES,
} from "./state-machine-policy.js";

export class LearningFlowValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "LearningFlowValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LearningFlowValidationError(code, message);
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
    if (!allowed.has(key)) {
      fail("unknown_field", `${path}.${key} não é permitido.`);
    }
  }
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_value", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

function nullableString(value, path) {
  return value === null ? null : string(value, path);
}

function enumValue(value, values, path) {
  if (!values.includes(value)) {
    fail("invalid_value", `${path} deve ser um de: ${values.join(", ")}.`);
  }
  return value;
}

function integer(value, path, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail("invalid_value", `${path} deve ser inteiro maior ou igual a ${min}.`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_value", `${path} deve ser booleano.`);
  }
  return value;
}

function timestamp(value, path) {
  const normalized = string(value, path);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    fail("invalid_value", `${path} deve ser timestamp ISO-8601 canônico.`);
  }
  return normalized;
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

export function createLearningFlowError(input, path = "LearningFlowError") {
  const value = record(input, path);
  exactKeys(value, ["code", "message", "retryable", "failed_event"], path);
  return deepFreeze({
    code: string(value.code, `${path}.code`),
    message: string(value.message, `${path}.message`),
    retryable: boolean(value.retryable, `${path}.retryable`),
    failed_event: value.failed_event === null
      ? null
      : enumValue(value.failed_event, LEARNING_FLOW_EVENTS, `${path}.failed_event`),
  });
}

export function createLearningFlowTransition(input, path = "LearningFlowTransition") {
  const value = record(input, path);
  exactKeys(value, [
    "from",
    "to",
    "from_status",
    "to_status",
    "event",
    "reason",
    "timestamp",
    "sequence",
    "policy_version",
    "event_version",
    "source_policy_version",
    "current_concept",
    "current_exercise_id",
  ], path);
  if (value.policy_version !== LEARNING_FLOW_POLICY_VERSION) {
    fail("invalid_policy_version", `${path}.policy_version deve ser ${LEARNING_FLOW_POLICY_VERSION}.`);
  }
  if (value.event_version !== LEARNING_FLOW_EVENT_VERSION) {
    fail("invalid_event_version", `${path}.event_version deve ser ${LEARNING_FLOW_EVENT_VERSION}.`);
  }

  return deepFreeze({
    from: enumValue(value.from, LEARNING_FLOW_PHASES, `${path}.from`),
    to: enumValue(value.to, LEARNING_FLOW_PHASES, `${path}.to`),
    from_status: enumValue(value.from_status, LEARNING_FLOW_STATUSES, `${path}.from_status`),
    to_status: enumValue(value.to_status, LEARNING_FLOW_STATUSES, `${path}.to_status`),
    event: enumValue(value.event, LEARNING_FLOW_EVENTS, `${path}.event`),
    reason: string(value.reason, `${path}.reason`),
    timestamp: timestamp(value.timestamp, `${path}.timestamp`),
    sequence: integer(value.sequence, `${path}.sequence`, { min: 1 }),
    policy_version: LEARNING_FLOW_POLICY_VERSION,
    event_version: LEARNING_FLOW_EVENT_VERSION,
    source_policy_version: nullableString(
      value.source_policy_version,
      `${path}.source_policy_version`,
    ),
    current_concept: nullableString(value.current_concept, `${path}.current_concept`),
    current_exercise_id: nullableString(
      value.current_exercise_id,
      `${path}.current_exercise_id`,
    ),
  });
}

export function createLearningFlowState(input, path = "LearningFlowState") {
  const value = record(input, path);
  exactKeys(value, [
    "session_id",
    "phase",
    "status",
    "transition_sequence",
    "transition_history",
    "current_concept",
    "current_exercise_id",
    "last_event",
    "error",
    "policy_version",
    "created_at",
    "updated_at",
  ], path);
  if (value.policy_version !== LEARNING_FLOW_POLICY_VERSION) {
    fail("invalid_policy_version", `${path}.policy_version deve ser ${LEARNING_FLOW_POLICY_VERSION}.`);
  }
  if (!Array.isArray(value.transition_history)) {
    fail("invalid_shape", `${path}.transition_history deve ser um array.`);
  }
  const history = Object.freeze(value.transition_history.map(
    (entry, index) => createLearningFlowTransition(
      entry,
      `${path}.transition_history[${index}]`,
    ),
  ));
  const sequence = integer(value.transition_sequence, `${path}.transition_sequence`);
  if (sequence !== history.length) {
    fail("invalid_history", `${path}.transition_sequence deve refletir o histórico.`);
  }
  for (const [index, transition] of history.entries()) {
    if (transition.sequence !== index + 1) {
      fail("invalid_history", `${path}.transition_history possui sequence descontínua.`);
    }
    if (index > 0) {
      const previous = history[index - 1];
      if (transition.from !== previous.to || transition.from_status !== previous.to_status) {
        fail("invalid_history", `${path}.transition_history não forma uma cadeia contínua.`);
      }
      if (transition.timestamp < previous.timestamp) {
        fail("invalid_history", `${path}.transition_history não é cronológico.`);
      }
    }
    if (index === 0 && (transition.from !== "PROBE" || transition.from_status !== "active")) {
      fail("invalid_history", `${path}.transition_history deve começar em PROBE/active.`);
    }
    const rule = findLearningFlowTransition(
      transition.from,
      transition.from_status,
      transition.event,
    );
    if (!rule || rule.to !== transition.to) {
      fail("invalid_history", `${path}.transition_history contém transição fora da política.`);
    }
    const expectedStatus = transition.event === "failure"
      ? "error"
      : transition.event === "learning_completed"
        ? "completed"
        : "active";
    if (transition.to_status !== expectedStatus) {
      fail("invalid_history", `${path}.transition_history contém status de destino inválido.`);
    }
  }
  const phase = enumValue(value.phase, LEARNING_FLOW_PHASES, `${path}.phase`);
  const status = enumValue(value.status, LEARNING_FLOW_STATUSES, `${path}.status`);
  const lastEvent = value.last_event === null
    ? null
    : enumValue(value.last_event, LEARNING_FLOW_EVENTS, `${path}.last_event`);
  const error = value.error === null
    ? null
    : createLearningFlowError(value.error, `${path}.error`);
  if ((status === "error") !== (error !== null)) {
    fail("invalid_status", `${path}.error deve existir somente quando status=error.`);
  }
  if ((phase === "COMPLETED") !== (status === "completed")) {
    fail("invalid_status", `${path}.phase COMPLETED e status completed devem ser coerentes.`);
  }
  if (status === "completed" && error !== null) {
    fail("invalid_status", `${path} concluído não pode conter erro.`);
  }
  if (history.length === 0 && lastEvent !== null) {
    fail("invalid_history", `${path}.last_event deve ser null sem transições.`);
  }
  if (history.length === 0 && (phase !== "PROBE" || status !== "active" || value.current_exercise_id !== null)) {
    fail("invalid_history", `${path} inicial deve estar em PROBE/active sem exercício.`);
  }
  if (history.length > 0) {
    const last = history.at(-1);
    if (last.event !== lastEvent || last.to !== phase || last.to_status !== status) {
      fail("invalid_history", `${path} não corresponde à última transição.`);
    }
    if (
      last.current_concept !== value.current_concept
      || last.current_exercise_id !== value.current_exercise_id
    ) {
      fail("invalid_history", `${path} diverge do snapshot da última transição.`);
    }
  }
  const createdAt = timestamp(value.created_at, `${path}.created_at`);
  const updatedAt = timestamp(value.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) {
    fail("invalid_timestamp", `${path}.updated_at não pode anteceder created_at.`);
  }
  if (history.length > 0 && history.at(-1).timestamp !== updatedAt) {
    fail("invalid_timestamp", `${path}.updated_at deve corresponder à última transição.`);
  }
  if (history.length === 0 && updatedAt !== createdAt) {
    fail("invalid_timestamp", `${path} inicial deve possuir timestamps iguais.`);
  }

  return deepFreeze({
    session_id: string(value.session_id, `${path}.session_id`),
    phase,
    status,
    transition_sequence: sequence,
    transition_history: history,
    current_concept: nullableString(value.current_concept, `${path}.current_concept`),
    current_exercise_id: nullableString(
      value.current_exercise_id,
      `${path}.current_exercise_id`,
    ),
    last_event: lastEvent,
    error,
    policy_version: LEARNING_FLOW_POLICY_VERSION,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}
