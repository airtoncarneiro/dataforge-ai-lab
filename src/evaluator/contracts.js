import { ADAPTIVE_ACTIONS } from "../adaptive-decision/index.js";
import {
  createEvaluation,
  createExecutionError,
} from "../domain/index.js";
import {
  RESULT_VALIDATION_STATUSES,
  createResultValidation,
} from "../result-validator/index.js";

export const EVALUATOR_POLICY_VERSION = "evaluator-policy-v1";

export const PEDAGOGICAL_ASSESSMENT_SOURCES = Object.freeze([
  "llm",
  "deterministic_fallback",
]);

export const UNDERSTANDING_LEVELS = Object.freeze([
  "demonstrated",
  "partial",
  "insufficient",
  "unknown",
]);

export const REASONING_QUALITIES = Object.freeze([
  "strong",
  "adequate",
  "superficial",
  "unclear",
]);

export class EvaluatorValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "EvaluatorValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvaluatorValidationError(code, message);
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

function boolean(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_value", `${path} deve ser booleano.`);
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail("invalid_value", `${path} deve ser um de: ${allowed.join(", ")}.`);
  }
  return value;
}

function jsonValue(value, path, seen = new Set()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      fail("invalid_json", `${path} contém Date inválida.`);
    }
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("invalid_json", `${path} contém referência circular.`);
    seen.add(value);
    const result = value.map((item, index) => jsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  const input = record(value, path);
  if (seen.has(input)) fail("invalid_json", `${path} contém referência circular.`);
  seen.add(input);
  const result = {};
  for (const [key, item] of Object.entries(input)) {
    result[key] = jsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(input);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneJson(value, path) {
  return deepFreeze(jsonValue(value, path));
}

function createObjectiveAssessment(input, path) {
  const value = record(input, path);
  exactKeys(value, [
    "status",
    "correct",
    "execution_status",
    "expected_summary",
    "actual_summary",
    "mismatches",
    "constraints",
    "plan_evidence",
  ], path);
  const status = enumValue(
    value.status,
    RESULT_VALIDATION_STATUSES,
    `${path}.status`,
  );
  const correct = boolean(value.correct, `${path}.correct`);
  if (correct !== (status === "correct")) {
    fail("objective_conflict", `${path}.correct deve corresponder ao status B16.`);
  }
  return deepFreeze({
    status,
    correct,
    execution_status: enumValue(
      value.execution_status,
      ["ok", "error", "not_executed"],
      `${path}.execution_status`,
    ),
    expected_summary: cloneJson(value.expected_summary, `${path}.expected_summary`),
    actual_summary: value.actual_summary === null
      ? null
      : cloneJson(value.actual_summary, `${path}.actual_summary`),
    mismatches: cloneJson(value.mismatches, `${path}.mismatches`),
    constraints: cloneJson(value.constraints, `${path}.constraints`),
    plan_evidence: value.plan_evidence === null
      ? null
      : cloneJson(value.plan_evidence, `${path}.plan_evidence`),
  });
}

function createPublicLlmError(input, path) {
  if (input === null) return null;
  const value = record(input, path);
  exactKeys(value, ["category", "code", "message"], path);
  return deepFreeze({
    category: string(value.category, `${path}.category`),
    code: string(value.code, `${path}.code`),
    message: string(value.message, `${path}.message`),
  });
}

function createPedagogicalAssessment(input, path) {
  const value = record(input, path);
  exactKeys(value, [
    "source",
    "understanding",
    "reasoning_quality",
    "summary",
    "llm_error",
  ], path);
  const source = enumValue(
    value.source,
    PEDAGOGICAL_ASSESSMENT_SOURCES,
    `${path}.source`,
  );
  const llmError = createPublicLlmError(value.llm_error, `${path}.llm_error`);
  if ((source === "llm") !== (llmError === null)) {
    fail(
      "invalid_provenance",
      `${path}.llm_error deve existir somente em fallback determinístico.`,
    );
  }
  return deepFreeze({
    source,
    understanding: enumValue(
      value.understanding,
      UNDERSTANDING_LEVELS,
      `${path}.understanding`,
    ),
    reasoning_quality: enumValue(
      value.reasoning_quality,
      REASONING_QUALITIES,
      `${path}.reasoning_quality`,
    ),
    summary: string(value.summary, `${path}.summary`),
    llm_error: llmError,
  });
}

function createEvidenceProjection(input, path) {
  const value = record(input, path);
  exactKeys(value, ["positive", "negative"], path);
  if (!Array.isArray(value.positive) || !Array.isArray(value.negative)) {
    fail("invalid_shape", `${path}.positive e negative devem ser arrays.`);
  }
  return deepFreeze({
    positive: cloneJson(value.positive, `${path}.positive`),
    negative: cloneJson(value.negative, `${path}.negative`),
  });
}

function createProvenance(input, path) {
  const value = record(input, path);
  exactKeys(value, [
    "exercise_id",
    "attempt_id",
    "validator_policy_version",
    "tutor_policy_version",
    "evaluator_policy_version",
    "llm_request_id",
  ], path);
  if (value.evaluator_policy_version !== EVALUATOR_POLICY_VERSION) {
    fail(
      "invalid_policy_version",
      `${path}.evaluator_policy_version deve ser ${EVALUATOR_POLICY_VERSION}.`,
    );
  }
  return deepFreeze({
    exercise_id: string(value.exercise_id, `${path}.exercise_id`),
    attempt_id: string(value.attempt_id, `${path}.attempt_id`),
    validator_policy_version: string(
      value.validator_policy_version,
      `${path}.validator_policy_version`,
    ),
    tutor_policy_version: string(value.tutor_policy_version, `${path}.tutor_policy_version`),
    evaluator_policy_version: EVALUATOR_POLICY_VERSION,
    llm_request_id: nullableString(value.llm_request_id, `${path}.llm_request_id`),
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createEvaluatorResult(input, path = "EvaluatorResult") {
  const value = record(input, path);
  exactKeys(value, [
    "evaluation",
    "objective_assessment",
    "pedagogical_assessment",
    "execution_error",
    "conceptual_errors",
    "misconceptions",
    "evidence",
    "feedback",
    "hints",
    "mastery_evidence",
    "suggested_next_action",
    "provenance",
    "evaluator_policy_version",
  ], path);
  if (value.evaluator_policy_version !== EVALUATOR_POLICY_VERSION) {
    fail(
      "invalid_policy_version",
      `${path}.evaluator_policy_version deve ser ${EVALUATOR_POLICY_VERSION}.`,
    );
  }

  const evaluation = createEvaluation(value.evaluation, `${path}.evaluation`);
  const objective = createObjectiveAssessment(
    value.objective_assessment,
    `${path}.objective_assessment`,
  );
  const pedagogical = createPedagogicalAssessment(
    value.pedagogical_assessment,
    `${path}.pedagogical_assessment`,
  );
  const executionError = value.execution_error === null
    ? null
    : createExecutionError(value.execution_error, `${path}.execution_error`);
  const evidence = createEvidenceProjection(value.evidence, `${path}.evidence`);
  const provenance = createProvenance(value.provenance, `${path}.provenance`);

  if (evaluation.assessment.correct !== objective.correct) {
    fail("objective_conflict", "Evaluation.assessment.correct deve reproduzir B16.");
  }
  const requiresExecutionError = [
    "execution_error",
    "security_violation",
    "timeout",
    "reference_validation_error",
  ].includes(objective.status);
  if (requiresExecutionError !== (executionError !== null)) {
    fail(
      "objective_conflict",
      "execution_error deve corresponder à classificação authoritative de B16.",
    );
  }
  if (
    (objective.status === "security_violation" && executionError?.category !== "security_violation")
    || (objective.status === "timeout" && executionError?.category !== "timeout")
  ) {
    fail("objective_conflict", "A categoria de execução diverge do status B16.");
  }
  if (!sameJson(evaluation.assessment.execution_error, executionError)) {
    fail("projection_conflict", "execution_error diverge de Evaluation.assessment.");
  }
  const projections = [
    [value.conceptual_errors, evaluation.assessment.conceptual_errors, "conceptual_errors"],
    [value.misconceptions, evaluation.assessment.misconceptions, "misconceptions"],
    [evidence.positive, evaluation.assessment.positive_evidence, "evidence.positive"],
    [evidence.negative, evaluation.assessment.negative_evidence, "evidence.negative"],
    [value.mastery_evidence, evaluation.mastery_evidence, "mastery_evidence"],
    [value.hints, evaluation.feedback.hints, "hints"],
  ];
  for (const [projection, canonical, label] of projections) {
    if (!sameJson(projection, canonical)) {
      fail("projection_conflict", `${label} diverge de Evaluation.`);
    }
  }
  if (value.feedback !== evaluation.feedback.message_to_learner) {
    fail("projection_conflict", "feedback diverge de Evaluation.feedback.");
  }
  const suggestedAction = enumValue(
    value.suggested_next_action,
    ADAPTIVE_ACTIONS,
    `${path}.suggested_next_action`,
  );
  if (evaluation.next_action !== suggestedAction) {
    fail("projection_conflict", "suggested_next_action diverge de Evaluation.next_action.");
  }
  if (
    provenance.exercise_id !== evaluation.exercise_id
    || provenance.attempt_id !== evaluation.attempt_id
  ) {
    fail("provenance_conflict", "Provenance deve identificar a Evaluation.");
  }

  return deepFreeze({
    evaluation,
    objective_assessment: objective,
    pedagogical_assessment: pedagogical,
    execution_error: executionError,
    conceptual_errors: evaluation.assessment.conceptual_errors,
    misconceptions: evaluation.assessment.misconceptions,
    evidence,
    feedback: evaluation.feedback.message_to_learner,
    hints: evaluation.feedback.hints,
    mastery_evidence: evaluation.mastery_evidence,
    suggested_next_action: suggestedAction,
    provenance,
    evaluator_policy_version: EVALUATOR_POLICY_VERSION,
  });
}

export function assertResultValidation(input) {
  try {
    return createResultValidation(input, "EvaluatorInput.validationResult");
  } catch {
    fail("invalid_validation_result", "validationResult não atende ao contrato B16.");
  }
}
