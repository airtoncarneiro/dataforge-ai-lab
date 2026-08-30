import {
  DomainValidationError,
  createExercise,
  createLearnerState,
} from "../domain/index.js";

export const EXERCISE_POLICY_VERSION = "exercise-policy-v1";

export const EXERCISE_DIFFICULTY_TARGETS = Object.freeze([
  "low",
  "medium",
  "high",
]);

export const EXERCISE_COMPARISON_MODES = Object.freeze([
  "RESULT_SET",
  "ORDERED_RESULT",
  "PROPERTY_BASED",
  "PLAN_CONSTRAINT",
]);

export const VALIDATION_CONSTRAINT_KINDS = Object.freeze([
  "result_property",
  "query_structure",
  "plan_property",
]);

export const VALIDATION_CONSTRAINT_OPERATORS = Object.freeze([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "at_least",
  "at_most",
  "greater_than",
  "less_than",
]);

export const EXERCISE_GENERATION_ERROR_CATEGORIES = Object.freeze([
  "generation_error",
  "llm_error",
]);

export class ExerciseValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ExerciseValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExerciseValidationError(code, message);
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

function integer(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_value", `${path} deve ser inteiro entre ${min} e ${max}.`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") {
    fail("invalid_value", `${path} deve ser booleano.`);
  }
  return value;
}

function strings(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail("invalid_shape", `${path} deve conter ao menos ${min} item(ns).`);
  }
  const normalized = value.map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("duplicate_value", `${path} não deve conter valores duplicados.`);
  }
  return Object.freeze(normalized);
}

function scalar(value, path) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  fail("invalid_value", `${path} deve ser um escalar JSON.`);
}

function constraintValue(value, kind, path) {
  // Structured output providers can serialize boolean constraint values as
  // strings. Query-structure facts are always boolean, so normalize only the
  // two canonical spellings at this trusted metadata boundary.
  if (kind === "query_structure" && typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return scalar(value, path);
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

function createValidationConstraint(input, path) {
  const value = record(input, path);
  exactKeys(value, ["kind", "target", "operator", "value"], path);
  return deepFreeze({
    kind: enumValue(value.kind, VALIDATION_CONSTRAINT_KINDS, `${path}.kind`),
    target: string(value.target, `${path}.target`),
    operator: enumValue(
      value.operator,
      VALIDATION_CONSTRAINT_OPERATORS,
      `${path}.operator`,
    ),
    value: constraintValue(value.value, value.kind, `${path}.value`),
  });
}

export function createExerciseValidationMetadata(
  input,
  path = "ExerciseValidationMetadata",
) {
  const value = record(input, path);
  exactKeys(value, [
    "expected_columns",
    "comparison_mode",
    "ordering_required",
    "expected_row_count",
    "reference_query",
    "concepts_evaluated",
    "source_relations",
    "constraints",
  ], path);
  if (!Array.isArray(value.constraints)) {
    fail("invalid_shape", `${path}.constraints deve ser um array.`);
  }
  const expectedRowCount = value.expected_row_count === null
    ? null
    : integer(value.expected_row_count, `${path}.expected_row_count`, { min: 0 });

  return deepFreeze({
    expected_columns: strings(value.expected_columns, `${path}.expected_columns`, { min: 1 }),
    comparison_mode: enumValue(
      value.comparison_mode,
      EXERCISE_COMPARISON_MODES,
      `${path}.comparison_mode`,
    ),
    ordering_required: boolean(value.ordering_required, `${path}.ordering_required`),
    expected_row_count: expectedRowCount,
    reference_query: nullableString(value.reference_query, `${path}.reference_query`),
    concepts_evaluated: strings(
      value.concepts_evaluated,
      `${path}.concepts_evaluated`,
      { min: 1 },
    ),
    source_relations: strings(value.source_relations, `${path}.source_relations`, { min: 1 }),
    constraints: Object.freeze(value.constraints.map(
      (item, index) => createValidationConstraint(item, `${path}.constraints[${index}]`),
    )),
  });
}

export function createGeneratedExercise(input, path = "GeneratedExercise") {
  const value = record(input, path);
  exactKeys(value, [
    "id",
    "target_concepts",
    "difficulty",
    "objective",
    "statement",
    "expected_skills",
    "validation_strategy",
    "evaluation_notes",
    "validation_metadata",
    "created_at",
  ], path);

  const targetConcepts = strings(
    value.target_concepts,
    `${path}.target_concepts`,
    { min: 1 },
  );
  const metadata = createExerciseValidationMetadata(
    value.validation_metadata,
    `${path}.validation_metadata`,
  );
  let exercise;
  try {
    exercise = createExercise({
      id: value.id,
      concepts: targetConcepts,
      difficulty: value.difficulty,
      objective: value.objective,
      statement: value.statement,
      expected_skills: value.expected_skills,
      validation_strategy: value.validation_strategy,
      evaluation_notes: value.evaluation_notes,
      reference_solution: null,
      created_at: value.created_at,
    }, `${path}.exercise`);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail("invalid_exercise", error.message);
    }
    throw error;
  }

  return deepFreeze({ exercise, validation_metadata: metadata });
}

export function toLearnerExercise(exerciseInput) {
  const exercise = createExercise(exerciseInput, "ExercisePublicProjection");
  return deepFreeze({
    id: exercise.id,
    concepts: [...exercise.concepts],
    difficulty: exercise.difficulty,
    objective: exercise.objective,
    statement: exercise.statement,
    expected_skills: [...exercise.expected_skills],
    validation_strategy: exercise.validation_strategy,
    created_at: exercise.created_at,
  });
}

function createGenerationError(input, path) {
  const value = record(input, path);
  exactKeys(value, ["category", "code", "message", "retryable"], path);
  return deepFreeze({
    category: enumValue(
      value.category,
      EXERCISE_GENERATION_ERROR_CATEGORIES,
      `${path}.category`,
    ),
    code: string(value.code, `${path}.code`),
    message: string(value.message, `${path}.message`),
    retryable: boolean(value.retryable, `${path}.retryable`),
  });
}

export function createExerciseGenerationResult(input, path = "ExerciseGenerationResult") {
  const value = record(input, path);
  exactKeys(value, [
    "status",
    "exercise",
    "validation_metadata",
    "attempts",
    "policy_version",
    "error",
  ], path);
  const status = enumValue(value.status, ["ok", "error"], `${path}.status`);
  const attempts = integer(value.attempts, `${path}.attempts`, { min: 1 });
  if (value.policy_version !== EXERCISE_POLICY_VERSION) {
    fail("invalid_policy_version", `${path}.policy_version deve ser ${EXERCISE_POLICY_VERSION}.`);
  }

  if (status === "ok") {
    if (value.exercise === null || value.validation_metadata === null || value.error !== null) {
      fail("invalid_result", `${path} de sucesso deve conter exercício e metadata, sem erro.`);
    }
    return deepFreeze({
      status,
      exercise: createExercise(value.exercise, `${path}.exercise`),
      validation_metadata: createExerciseValidationMetadata(
        value.validation_metadata,
        `${path}.validation_metadata`,
      ),
      attempts,
      policy_version: EXERCISE_POLICY_VERSION,
      error: null,
    });
  }

  if (value.exercise !== null || value.validation_metadata !== null || value.error === null) {
    fail("invalid_result", `${path} de erro não deve conter exercício ou metadata.`);
  }
  return deepFreeze({
    status,
    exercise: null,
    validation_metadata: null,
    attempts,
    policy_version: EXERCISE_POLICY_VERSION,
    error: createGenerationError(value.error, `${path}.error`),
  });
}

export function assertLearnerState(input) {
  try {
    return createLearnerState(input);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail("invalid_learner_state", "learnerState não atende ao contrato B07.");
    }
    throw error;
  }
}
