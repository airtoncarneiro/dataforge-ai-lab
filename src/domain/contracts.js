import {
  CONFIDENCE_LEVELS,
  EVALUATION_EVIDENCE_SOURCES,
  EVIDENCE_STRENGTHS,
  EXECUTION_ERROR_CATEGORIES,
  EXECUTION_STATUSES,
  MASTERY_DIRECTIONS,
  MISCONCEPTION_STATUSES,
  NEXT_ACTIONS,
  SESSION_PHASES,
  VALIDATION_STRATEGIES,
} from "./constants.js";
import {
  DomainValidationError,
  arrayOf,
  assertExactKeys,
  assertRecord,
  booleanValue,
  canonicalTimestamp,
  deepFreeze,
  enumValue,
  finiteNumber,
  jsonValue,
  nonNegativeInteger,
  nullableString,
  positiveInteger,
  requiredString,
  scalarJsonValue,
  stringArray,
  valueOrDefault,
} from "./validation.js";

function contractInput(input, path, keys) {
  const record = assertRecord(input, path);
  assertExactKeys(record, keys, path);
  return record;
}

function nullableId(value, path) {
  return value === null ? null : requiredString(value, path);
}

function assertChronology(createdAt, updatedAt, path) {
  if (updatedAt < createdAt) {
    throw new DomainValidationError(`${path}.updated_at`, "não pode ser anterior a created_at");
  }
}

function assertUnique(values, path, selector) {
  const selected = values.map(selector);
  if (new Set(selected).size !== selected.length) {
    throw new DomainValidationError(path, "não deve conter itens duplicados");
  }
}

export function createEvidenceDetail(input, path = "EvidenceDetail") {
  const value = contractInput(input, path, ["key", "value"]);
  return deepFreeze({
    key: requiredString(value.key, `${path}.key`),
    value: scalarJsonValue(value.value, `${path}.value`),
  });
}

export function createEvaluationEvidence(input, path = "EvaluationEvidence") {
  const value = contractInput(input, path, [
    "id",
    "source",
    "description",
    "details",
    "observed_at",
  ]);
  const details = arrayOf(
    valueOrDefault(value, "details", []),
    `${path}.details`,
    createEvidenceDetail,
  );
  assertUnique(details, `${path}.details`, (detail) => detail.key);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    source: enumValue(value.source, EVALUATION_EVIDENCE_SOURCES, `${path}.source`),
    description: requiredString(value.description, `${path}.description`),
    details,
    observed_at: canonicalTimestamp(value.observed_at, `${path}.observed_at`),
  });
}

export function createMisconception(input, path = "Misconception") {
  const value = contractInput(input, path, [
    "id",
    "concept",
    "description",
    "status",
    "evidence_ids",
    "observed_at",
  ]);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    concept: requiredString(value.concept, `${path}.concept`),
    description: requiredString(value.description, `${path}.description`),
    status: enumValue(
      valueOrDefault(value, "status", "suspected"),
      MISCONCEPTION_STATUSES,
      `${path}.status`,
    ),
    evidence_ids: stringArray(
      valueOrDefault(value, "evidence_ids", []),
      `${path}.evidence_ids`,
    ),
    observed_at: canonicalTimestamp(value.observed_at, `${path}.observed_at`),
  });
}

export function createConceptualError(input, path = "ConceptualError") {
  const value = contractInput(input, path, ["code", "concept", "description"]);
  return deepFreeze({
    code: requiredString(value.code, `${path}.code`),
    concept: requiredString(value.concept, `${path}.concept`),
    description: requiredString(value.description, `${path}.description`),
  });
}

export function createExecutionError(input, path = "ExecutionError") {
  const value = contractInput(input, path, ["category", "sqlstate", "message"]);
  const sqlstate = valueOrDefault(value, "sqlstate", null);
  if (sqlstate !== null && (typeof sqlstate !== "string" || !/^[0-9A-Z]{5}$/u.test(sqlstate))) {
    throw new DomainValidationError(
      `${path}.sqlstate`,
      "deve ser null ou um SQLSTATE com cinco caracteres",
    );
  }

  return deepFreeze({
    category: enumValue(
      value.category,
      EXECUTION_ERROR_CATEGORIES,
      `${path}.category`,
    ),
    sqlstate,
    message: requiredString(value.message, `${path}.message`),
  });
}

export function createFeedback(input, path = "Feedback") {
  const value = contractInput(input, path, ["message_to_learner", "hints"]);
  return deepFreeze({
    message_to_learner: requiredString(
      value.message_to_learner,
      `${path}.message_to_learner`,
    ),
    hints: stringArray(valueOrDefault(value, "hints", []), `${path}.hints`),
  });
}

export function createConceptState(input, path = "ConceptState") {
  const value = contractInput(input, path, [
    "id",
    "concept",
    "mastery",
    "confidence",
    "misconceptions",
    "evidence_ids",
    "created_at",
    "updated_at",
  ]);
  const createdAt = canonicalTimestamp(value.created_at, `${path}.created_at`);
  const updatedAt = canonicalTimestamp(value.updated_at, `${path}.updated_at`);
  assertChronology(createdAt, updatedAt, path);
  const misconceptions = arrayOf(
    valueOrDefault(value, "misconceptions", []),
    `${path}.misconceptions`,
    createMisconception,
  );
  assertUnique(misconceptions, `${path}.misconceptions`, (item) => item.id);
  for (const misconception of misconceptions) {
    if (misconception.concept !== value.concept) {
      throw new DomainValidationError(
        `${path}.misconceptions`,
        "cada misconception deve pertencer ao conceito do estado",
      );
    }
  }

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    concept: requiredString(value.concept, `${path}.concept`),
    mastery: finiteNumber(valueOrDefault(value, "mastery", 0), `${path}.mastery`, {
      min: 0,
      max: 1,
    }),
    confidence: enumValue(
      valueOrDefault(value, "confidence", "low"),
      CONFIDENCE_LEVELS,
      `${path}.confidence`,
    ),
    misconceptions,
    evidence_ids: stringArray(
      valueOrDefault(value, "evidence_ids", []),
      `${path}.evidence_ids`,
    ),
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

export function createLearnerState(input, path = "LearnerState") {
  const value = contractInput(input, path, [
    "id",
    "session_id",
    "learning_goal",
    "concepts",
    "created_at",
    "updated_at",
  ]);
  const createdAt = canonicalTimestamp(value.created_at, `${path}.created_at`);
  const updatedAt = canonicalTimestamp(value.updated_at, `${path}.updated_at`);
  assertChronology(createdAt, updatedAt, path);
  const concepts = arrayOf(
    valueOrDefault(value, "concepts", []),
    `${path}.concepts`,
    createConceptState,
  );
  assertUnique(concepts, `${path}.concepts`, (concept) => concept.concept);
  assertUnique(concepts, `${path}.concepts`, (concept) => concept.id);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    session_id: requiredString(value.session_id, `${path}.session_id`),
    learning_goal: requiredString(value.learning_goal, `${path}.learning_goal`),
    concepts,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

export function createLearningSession(input, path = "LearningSession") {
  const value = contractInput(input, path, [
    "id",
    "learning_goal",
    "phase",
    "learner_state_id",
    "current_exercise_id",
    "created_at",
    "updated_at",
  ]);
  const createdAt = canonicalTimestamp(value.created_at, `${path}.created_at`);
  const updatedAt = canonicalTimestamp(value.updated_at, `${path}.updated_at`);
  assertChronology(createdAt, updatedAt, path);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    learning_goal: requiredString(value.learning_goal, `${path}.learning_goal`),
    phase: enumValue(
      valueOrDefault(value, "phase", "PROBE"),
      SESSION_PHASES,
      `${path}.phase`,
    ),
    learner_state_id: requiredString(value.learner_state_id, `${path}.learner_state_id`),
    current_exercise_id: nullableId(
      valueOrDefault(value, "current_exercise_id", null),
      `${path}.current_exercise_id`,
    ),
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

export function createExercise(input, path = "Exercise") {
  const value = contractInput(input, path, [
    "id",
    "concepts",
    "difficulty",
    "objective",
    "statement",
    "expected_skills",
    "validation_strategy",
    "evaluation_notes",
    "reference_solution",
    "created_at",
  ]);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    concepts: stringArray(value.concepts, `${path}.concepts`, { min: 1 }),
    difficulty: positiveInteger(value.difficulty, `${path}.difficulty`),
    objective: requiredString(value.objective, `${path}.objective`),
    statement: requiredString(value.statement, `${path}.statement`),
    expected_skills: stringArray(value.expected_skills, `${path}.expected_skills`, { min: 1 }),
    validation_strategy: enumValue(
      value.validation_strategy,
      VALIDATION_STRATEGIES,
      `${path}.validation_strategy`,
    ),
    evaluation_notes: stringArray(
      valueOrDefault(value, "evaluation_notes", []),
      `${path}.evaluation_notes`,
      { unique: false },
    ),
    reference_solution: nullableString(
      valueOrDefault(value, "reference_solution", null),
      `${path}.reference_solution`,
    ),
    created_at: canonicalTimestamp(value.created_at, `${path}.created_at`),
  });
}

export function createAttempt(input, path = "Attempt") {
  const value = contractInput(input, path, [
    "id",
    "session_id",
    "exercise_id",
    "submission",
    "execution_evidence_id",
    "submitted_at",
  ]);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    session_id: requiredString(value.session_id, `${path}.session_id`),
    exercise_id: requiredString(value.exercise_id, `${path}.exercise_id`),
    submission: requiredString(value.submission, `${path}.submission`),
    execution_evidence_id: nullableId(
      valueOrDefault(value, "execution_evidence_id", null),
      `${path}.execution_evidence_id`,
    ),
    submitted_at: canonicalTimestamp(value.submitted_at, `${path}.submitted_at`),
  });
}

export function createExecutionEvidence(input, path = "ExecutionEvidence") {
  const value = contractInput(input, path, [
    "id",
    "attempt_id",
    "status",
    "columns",
    "rows",
    "row_count",
    "truncated",
    "duration_ms",
    "error",
    "explain",
    "created_at",
  ]);
  const status = enumValue(value.status, EXECUTION_STATUSES, `${path}.status`);
  const columns = stringArray(valueOrDefault(value, "columns", []), `${path}.columns`, {
    unique: false,
  });
  const rows = arrayOf(
    valueOrDefault(value, "rows", []),
    `${path}.rows`,
    (row, rowPath) => jsonValue(row, rowPath),
  );
  const rowCount = nonNegativeInteger(
    valueOrDefault(value, "row_count", 0),
    `${path}.row_count`,
  );
  if (rowCount !== rows.length) {
    throw new DomainValidationError(
      `${path}.row_count`,
      "deve corresponder à quantidade de rows retornadas",
    );
  }
  const errorInput = valueOrDefault(value, "error", null);
  const error = errorInput === null ? null : createExecutionError(errorInput, `${path}.error`);
  if ((status === "ok" && error !== null) || (status === "error" && error === null)) {
    throw new DomainValidationError(`${path}.error`, "deve ser coerente com status");
  }
  if (status === "error" && (columns.length > 0 || rows.length > 0 || rowCount !== 0)) {
    throw new DomainValidationError(path, "uma falha não deve conter resultado parcial");
  }
  const explainInput = valueOrDefault(value, "explain", null);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    attempt_id: requiredString(value.attempt_id, `${path}.attempt_id`),
    status,
    columns,
    rows,
    row_count: rowCount,
    truncated: booleanValue(valueOrDefault(value, "truncated", false), `${path}.truncated`),
    duration_ms: finiteNumber(
      valueOrDefault(value, "duration_ms", 0),
      `${path}.duration_ms`,
      { min: 0 },
    ),
    error,
    explain: explainInput === null ? null : jsonValue(explainInput, `${path}.explain`),
    created_at: canonicalTimestamp(value.created_at, `${path}.created_at`),
  });
}

export function createAssessment(input, path = "Assessment") {
  const value = contractInput(input, path, [
    "correct",
    "execution_error",
    "conceptual_errors",
    "misconceptions",
    "positive_evidence",
    "negative_evidence",
    "prerequisites_to_revisit",
  ]);
  const correct = booleanValue(value.correct, `${path}.correct`);
  const executionErrorInput = valueOrDefault(value, "execution_error", null);
  const executionError = executionErrorInput === null
    ? null
    : createExecutionError(executionErrorInput, `${path}.execution_error`);
  if (correct && executionError !== null) {
    throw new DomainValidationError(path, "uma avaliação correta não pode conter execution_error");
  }

  const conceptualErrors = arrayOf(
    valueOrDefault(value, "conceptual_errors", []),
    `${path}.conceptual_errors`,
    createConceptualError,
  );
  const misconceptions = arrayOf(
    valueOrDefault(value, "misconceptions", []),
    `${path}.misconceptions`,
    createMisconception,
  );
  const positiveEvidence = arrayOf(
    valueOrDefault(value, "positive_evidence", []),
    `${path}.positive_evidence`,
    createEvaluationEvidence,
  );
  const negativeEvidence = arrayOf(
    valueOrDefault(value, "negative_evidence", []),
    `${path}.negative_evidence`,
    createEvaluationEvidence,
  );
  assertUnique(conceptualErrors, `${path}.conceptual_errors`, (error) => error.code);
  assertUnique(misconceptions, `${path}.misconceptions`, (item) => item.id);
  assertUnique(
    [...positiveEvidence, ...negativeEvidence],
    `${path}.positive_evidence/${path}.negative_evidence`,
    (evidence) => evidence.id,
  );

  return deepFreeze({
    correct,
    execution_error: executionError,
    conceptual_errors: conceptualErrors,
    misconceptions,
    positive_evidence: positiveEvidence,
    negative_evidence: negativeEvidence,
    prerequisites_to_revisit: stringArray(
      valueOrDefault(value, "prerequisites_to_revisit", []),
      `${path}.prerequisites_to_revisit`,
    ),
  });
}

export function createMasteryEvidence(input, path = "MasteryEvidence") {
  const value = contractInput(input, path, [
    "id",
    "attempt_id",
    "concept",
    "direction",
    "strength",
    "reason",
    "observed_at",
  ]);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    attempt_id: requiredString(value.attempt_id, `${path}.attempt_id`),
    concept: requiredString(value.concept, `${path}.concept`),
    direction: enumValue(value.direction, MASTERY_DIRECTIONS, `${path}.direction`),
    strength: enumValue(value.strength, EVIDENCE_STRENGTHS, `${path}.strength`),
    reason: requiredString(value.reason, `${path}.reason`),
    observed_at: canonicalTimestamp(value.observed_at, `${path}.observed_at`),
  });
}

export function createEvaluation(input, path = "Evaluation") {
  const value = contractInput(input, path, [
    "id",
    "attempt_id",
    "exercise_id",
    "assessment",
    "feedback",
    "mastery_evidence",
    "next_action",
    "evaluated_at",
  ]);

  const attemptId = requiredString(value.attempt_id, `${path}.attempt_id`);
  const masteryEvidence = arrayOf(
    valueOrDefault(value, "mastery_evidence", []),
    `${path}.mastery_evidence`,
    createMasteryEvidence,
  );
  assertUnique(masteryEvidence, `${path}.mastery_evidence`, (evidence) => evidence.id);
  for (const evidence of masteryEvidence) {
    if (evidence.attempt_id !== attemptId) {
      throw new DomainValidationError(
        `${path}.mastery_evidence`,
        "cada evidência deve referenciar o attempt_id da avaliação",
      );
    }
  }

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    attempt_id: attemptId,
    exercise_id: requiredString(value.exercise_id, `${path}.exercise_id`),
    assessment: createAssessment(value.assessment, `${path}.assessment`),
    feedback: createFeedback(value.feedback, `${path}.feedback`),
    mastery_evidence: masteryEvidence,
    next_action: enumValue(value.next_action, NEXT_ACTIONS, `${path}.next_action`),
    evaluated_at: canonicalTimestamp(value.evaluated_at, `${path}.evaluated_at`),
  });
}

export function createMasteryChange(input, path = "MasteryChange") {
  const value = contractInput(input, path, [
    "id",
    "concept_state_id",
    "attempt_id",
    "previous_mastery",
    "new_mastery",
    "previous_confidence",
    "new_confidence",
    "mastery_evidence_ids",
    "policy_version",
    "changed_at",
  ]);

  return deepFreeze({
    id: requiredString(value.id, `${path}.id`),
    concept_state_id: requiredString(value.concept_state_id, `${path}.concept_state_id`),
    attempt_id: requiredString(value.attempt_id, `${path}.attempt_id`),
    previous_mastery: finiteNumber(value.previous_mastery, `${path}.previous_mastery`, {
      min: 0,
      max: 1,
    }),
    new_mastery: finiteNumber(value.new_mastery, `${path}.new_mastery`, {
      min: 0,
      max: 1,
    }),
    previous_confidence: enumValue(
      value.previous_confidence,
      CONFIDENCE_LEVELS,
      `${path}.previous_confidence`,
    ),
    new_confidence: enumValue(
      value.new_confidence,
      CONFIDENCE_LEVELS,
      `${path}.new_confidence`,
    ),
    mastery_evidence_ids: stringArray(
      value.mastery_evidence_ids,
      `${path}.mastery_evidence_ids`,
      { min: 1 },
    ),
    policy_version: requiredString(value.policy_version, `${path}.policy_version`),
    changed_at: canonicalTimestamp(value.changed_at, `${path}.changed_at`),
  });
}
