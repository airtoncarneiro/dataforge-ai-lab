export const RESULT_VALIDATOR_POLICY_VERSION = "result-validator-policy-v1";

export const RESULT_VALIDATION_STATUSES = Object.freeze([
  "correct",
  "incorrect_result",
  "wrong_columns",
  "wrong_row_count",
  "ordering_mismatch",
  "constraint_violation",
  "execution_error",
  "security_violation",
  "timeout",
  "reference_validation_error",
]);

export const RESULT_MISMATCH_CODES = Object.freeze([
  "incorrect_result",
  "wrong_columns",
  "wrong_row_count",
  "ordering_mismatch",
  "constraint_violation",
  "actual_result_truncated",
  "reference_query_invalid",
  "reference_execution_error",
  "reference_result_truncated",
  "reference_columns_mismatch",
  "reference_row_count_mismatch",
  "metadata_mismatch",
  "unsupported_constraint",
  "student_execution_error",
  "plan_validation_error",
]);

export class ResultValidatorConfigurationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ResultValidatorConfigurationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResultValidatorConfigurationError(code, message);
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

function enumValue(value, values, path) {
  if (!values.includes(value)) {
    fail("invalid_value", `${path} deve ser um de: ${values.join(", ")}.`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_value", `${path} deve ser booleano.`);
  }
  return value;
}

function integer(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_value", `${path} deve ser inteiro não negativo.`);
  }
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("invalid_value", `${path} deve ser número finito não negativo.`);
  }
  return value;
}

function strings(value, path) {
  if (!Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um array.`);
  }
  return Object.freeze(value.map((item, index) => string(item, `${path}[${index}]`)));
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
    if (seen.has(value)) {
      fail("invalid_json", `${path} contém referência circular.`);
    }
    seen.add(value);
    const result = value.map((item, index) => jsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  const input = record(value, path);
  if (seen.has(input)) {
    fail("invalid_json", `${path} contém referência circular.`);
  }
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
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function nullable(value, mapper, path) {
  return value === null ? null : mapper(value, path);
}

function createExecution(input, path) {
  const value = record(input, path);
  exactKeys(value, [
    "status",
    "columns",
    "rows",
    "row_count",
    "truncated",
    "duration_ms",
    "error",
  ], path);
  const status = enumValue(value.status, ["ok", "error"], `${path}.status`);
  const error = value.error === null ? null : jsonValue(value.error, `${path}.error`);
  if ((status === "ok") !== (error === null)) {
    fail("invalid_execution", `${path}.error não corresponde ao status.`);
  }
  return deepFreeze({
    status,
    columns: strings(value.columns, `${path}.columns`),
    rows: jsonValue(value.rows, `${path}.rows`),
    row_count: integer(value.row_count, `${path}.row_count`),
    truncated: boolean(value.truncated, `${path}.truncated`),
    duration_ms: finiteNumber(value.duration_ms, `${path}.duration_ms`),
    error,
  });
}

function createExpectedSummary(input, path) {
  const value = record(input, path);
  exactKeys(value, [
    "comparison_mode",
    "expected_columns",
    "expected_row_count",
    "ordering_required",
    "reference_executed",
  ], path);
  return deepFreeze({
    comparison_mode: string(value.comparison_mode, `${path}.comparison_mode`),
    expected_columns: strings(value.expected_columns, `${path}.expected_columns`),
    expected_row_count: value.expected_row_count === null
      ? null
      : integer(value.expected_row_count, `${path}.expected_row_count`),
    ordering_required: boolean(value.ordering_required, `${path}.ordering_required`),
    reference_executed: boolean(value.reference_executed, `${path}.reference_executed`),
  });
}

function createActualSummary(input, path) {
  const value = record(input, path);
  exactKeys(value, ["columns", "row_count", "truncated", "result_digest"], path);
  return deepFreeze({
    columns: strings(value.columns, `${path}.columns`),
    row_count: integer(value.row_count, `${path}.row_count`),
    truncated: boolean(value.truncated, `${path}.truncated`),
    result_digest: string(value.result_digest, `${path}.result_digest`),
  });
}

function createMismatch(input, path) {
  const value = record(input, path);
  exactKeys(value, ["code", "field", "expected", "actual"], path);
  return deepFreeze({
    code: enumValue(value.code, RESULT_MISMATCH_CODES, `${path}.code`),
    field: string(value.field, `${path}.field`),
    expected: jsonValue(value.expected, `${path}.expected`),
    actual: jsonValue(value.actual, `${path}.actual`),
  });
}

function createConstraintEvidence(input, path) {
  const value = record(input, path);
  exactKeys(value, ["kind", "target", "operator", "expected", "actual", "passed"], path);
  return deepFreeze({
    kind: string(value.kind, `${path}.kind`),
    target: string(value.target, `${path}.target`),
    operator: string(value.operator, `${path}.operator`),
    expected: jsonValue(value.expected, `${path}.expected`),
    actual: jsonValue(value.actual, `${path}.actual`),
    passed: boolean(value.passed, `${path}.passed`),
  });
}

function createPlanEvidence(input, path) {
  return deepFreeze(jsonValue(input, path));
}

export function createResultValidation(input, path = "ResultValidation") {
  const value = record(input, path);
  exactKeys(value, [
    "status",
    "correct",
    "execution",
    "expected_summary",
    "actual_summary",
    "mismatches",
    "constraints",
    "plan_evidence",
    "validator_policy_version",
  ], path);
  const status = enumValue(value.status, RESULT_VALIDATION_STATUSES, `${path}.status`);
  const correct = boolean(value.correct, `${path}.correct`);
  if (correct !== (status === "correct")) {
    fail("invalid_result", `${path}.correct deve corresponder ao status.`);
  }
  if (!Array.isArray(value.mismatches) || !Array.isArray(value.constraints)) {
    fail("invalid_shape", `${path}.mismatches e constraints devem ser arrays.`);
  }
  if (correct && (value.mismatches.length > 0 || value.constraints.some((item) => !item.passed))) {
    fail("invalid_result", `${path} correto não pode conter falhas objetivas.`);
  }
  if (value.validator_policy_version !== RESULT_VALIDATOR_POLICY_VERSION) {
    fail(
      "invalid_policy_version",
      `${path}.validator_policy_version deve ser ${RESULT_VALIDATOR_POLICY_VERSION}.`,
    );
  }

  return deepFreeze({
    status,
    correct,
    execution: nullable(value.execution, createExecution, `${path}.execution`),
    expected_summary: createExpectedSummary(
      value.expected_summary,
      `${path}.expected_summary`,
    ),
    actual_summary: nullable(
      value.actual_summary,
      createActualSummary,
      `${path}.actual_summary`,
    ),
    mismatches: Object.freeze(value.mismatches.map(
      (item, index) => createMismatch(item, `${path}.mismatches[${index}]`),
    )),
    constraints: Object.freeze(value.constraints.map(
      (item, index) => createConstraintEvidence(item, `${path}.constraints[${index}]`),
    )),
    plan_evidence: nullable(
      value.plan_evidence,
      createPlanEvidence,
      `${path}.plan_evidence`,
    ),
    validator_policy_version: RESULT_VALIDATOR_POLICY_VERSION,
  });
}

export function cloneJson(value, path = "value") {
  return deepFreeze(jsonValue(value, path));
}

