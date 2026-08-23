import {
  createEvaluation,
  createLearnerState,
  createMasteryChange,
} from "../domain/index.js";

export const PROBE_STATUSES = Object.freeze(["active", "completed", "error"]);
export const PROBE_COMPLETION_REASONS = Object.freeze([
  "sufficient_evidence",
  "max_questions",
  "llm_failure",
]);
export const PROBE_QUESTION_TYPES = Object.freeze([
  "conceptual",
  "explanatory",
  "comparative",
  "small_problem",
]);
export const PROBE_QUESTION_INTENTS = Object.freeze([
  "discriminative",
  "coverage",
  "depth_check",
  "prerequisite_check",
]);

export class ProbeValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "ProbeValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeValidationError(code, message);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um objeto.`);
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

function integer(value, path, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_value", `${path} deve ser inteiro entre ${min} e ${max}.`);
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

function strings(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail("invalid_shape", `${path} deve ser array com ao menos ${min} item(ns).`);
  }
  const items = value.map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) {
    fail("duplicate_value", `${path} não deve conter valores duplicados.`);
  }
  return Object.freeze(items);
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

export function createProbeQuestion(input, path = "ProbeQuestion") {
  const value = record(input, path);
  exactKeys(value, [
    "id",
    "concept",
    "targets",
    "question_type",
    "intent",
    "difficulty",
    "question",
    "reason",
    "created_at",
  ], path);
  const targets = strings(value.targets, `${path}.targets`, { min: 1 });
  const concept = string(value.concept, `${path}.concept`);
  if (!targets.includes(concept)) {
    fail("invalid_value", `${path}.targets deve incluir o conceito atual.`);
  }

  return deepFreeze({
    id: string(value.id, `${path}.id`),
    concept,
    targets,
    question_type: enumValue(
      value.question_type,
      PROBE_QUESTION_TYPES,
      `${path}.question_type`,
    ),
    intent: enumValue(value.intent, PROBE_QUESTION_INTENTS, `${path}.intent`),
    difficulty: integer(value.difficulty, `${path}.difficulty`, { min: 1, max: 5 }),
    question: string(value.question, `${path}.question`),
    reason: string(value.reason, `${path}.reason`),
    created_at: timestamp(value.created_at, `${path}.created_at`),
  });
}

export function createProbeHistoryEntry(input, path = "ProbeHistoryEntry") {
  const value = record(input, path);
  exactKeys(value, [
    "id",
    "question",
    "answer",
    "evaluation",
    "mastery_changes",
    "answered_at",
  ], path);
  const question = createProbeQuestion(value.question, `${path}.question`);
  const answer = value.answer === null ? null : string(value.answer, `${path}.answer`);
  const evaluation = value.evaluation === null
    ? null
    : createEvaluation(value.evaluation, `${path}.evaluation`);
  if (!Array.isArray(value.mastery_changes)) {
    fail("invalid_shape", `${path}.mastery_changes deve ser um array.`);
  }
  const masteryChanges = Object.freeze(value.mastery_changes.map(
    (change, index) => createMasteryChange(change, `${path}.mastery_changes[${index}]`),
  ));
  const answeredAt = value.answered_at === null
    ? null
    : timestamp(value.answered_at, `${path}.answered_at`);
  const pending = answer === null && evaluation === null && answeredAt === null;
  const answered = answer !== null && evaluation !== null && answeredAt !== null;
  if (!pending && !answered) {
    fail("invalid_history", `${path} deve estar totalmente pendente ou totalmente avaliado.`);
  }
  if (pending && masteryChanges.length > 0) {
    fail("invalid_history", `${path} pendente não pode conter MasteryChange.`);
  }

  return deepFreeze({
    id: string(value.id, `${path}.id`),
    question,
    answer,
    evaluation,
    mastery_changes: masteryChanges,
    answered_at: answeredAt,
  });
}

function createProbeError(input, path) {
  const value = record(input, path);
  exactKeys(value, ["category", "code", "message"], path);
  return deepFreeze({
    category: string(value.category, `${path}.category`),
    code: string(value.code, `${path}.code`),
    message: string(value.message, `${path}.message`),
  });
}

export function createProbeResult(input, path = "ProbeResult") {
  const value = record(input, path);
  exactKeys(value, [
    "evaluated_concepts",
    "mastered_concepts",
    "partial_concepts",
    "gaps",
    "confidence",
    "misconceptions",
    "next_concept_recommended",
    "completion_reason",
  ], path);
  if (!Array.isArray(value.confidence) || !Array.isArray(value.misconceptions)) {
    fail("invalid_shape", `${path}.confidence e misconceptions devem ser arrays.`);
  }
  const confidence = value.confidence.map((item, index) => {
    const entry = record(item, `${path}.confidence[${index}]`);
    exactKeys(entry, ["concept", "confidence"], `${path}.confidence[${index}]`);
    return {
      concept: string(entry.concept, `${path}.confidence[${index}].concept`),
      confidence: enumValue(
        entry.confidence,
        ["low", "medium", "high"],
        `${path}.confidence[${index}].confidence`,
      ),
    };
  });
  const misconceptions = value.misconceptions.map((item, index) => {
    const entry = record(item, `${path}.misconceptions[${index}]`);
    exactKeys(entry, ["id", "concept", "description", "status"], `${path}.misconceptions[${index}]`);
    return {
      id: string(entry.id, `${path}.misconceptions[${index}].id`),
      concept: string(entry.concept, `${path}.misconceptions[${index}].concept`),
      description: string(entry.description, `${path}.misconceptions[${index}].description`),
      status: enumValue(
        entry.status,
        ["suspected", "confirmed", "resolved"],
        `${path}.misconceptions[${index}].status`,
      ),
    };
  });

  return deepFreeze({
    evaluated_concepts: strings(value.evaluated_concepts, `${path}.evaluated_concepts`),
    mastered_concepts: strings(value.mastered_concepts, `${path}.mastered_concepts`),
    partial_concepts: strings(value.partial_concepts, `${path}.partial_concepts`),
    gaps: strings(value.gaps, `${path}.gaps`),
    confidence: Object.freeze(confidence),
    misconceptions: Object.freeze(misconceptions),
    next_concept_recommended: nullableString(
      value.next_concept_recommended,
      `${path}.next_concept_recommended`,
    ),
    completion_reason: enumValue(
      value.completion_reason,
      PROBE_COMPLETION_REASONS.filter((reason) => reason !== "llm_failure"),
      `${path}.completion_reason`,
    ),
  });
}

export function createProbeSession(input, path = "ProbeSession") {
  const value = record(input, path);
  exactKeys(value, [
    "id",
    "learning_goal",
    "primary_concepts",
    "target_concepts",
    "evaluated_concepts",
    "current_concept",
    "current_difficulty",
    "question_count",
    "max_questions",
    "status",
    "learner_state",
    "history",
    "completion_reason",
    "result",
    "error",
    "policy_version",
    "created_at",
    "updated_at",
  ], path);
  const primaryConcepts = strings(value.primary_concepts, `${path}.primary_concepts`, { min: 1 });
  const targetConcepts = strings(value.target_concepts, `${path}.target_concepts`, { min: 1 });
  if (primaryConcepts.some((concept) => !targetConcepts.includes(concept))) {
    fail("invalid_session", `${path}.primary_concepts deve ser subconjunto de target_concepts.`);
  }
  const evaluatedConcepts = strings(value.evaluated_concepts, `${path}.evaluated_concepts`);
  if (evaluatedConcepts.some((concept) => !targetConcepts.includes(concept))) {
    fail("invalid_session", `${path}.evaluated_concepts deve ser subconjunto de target_concepts.`);
  }
  if (!Array.isArray(value.history)) {
    fail("invalid_shape", `${path}.history deve ser um array.`);
  }
  const history = Object.freeze(value.history.map(
    (entry, index) => createProbeHistoryEntry(entry, `${path}.history[${index}]`),
  ));
  const questionCount = integer(value.question_count, `${path}.question_count`, { min: 0, max: 12 });
  const maxQuestions = integer(value.max_questions, `${path}.max_questions`, { min: 5, max: 12 });
  if (questionCount !== history.length || questionCount > maxQuestions) {
    fail("invalid_session", `${path}.question_count deve refletir history e respeitar max_questions.`);
  }
  const status = enumValue(value.status, PROBE_STATUSES, `${path}.status`);
  const currentConcept = nullableString(value.current_concept, `${path}.current_concept`);
  const completionReason = value.completion_reason === null
    ? null
    : enumValue(
      value.completion_reason,
      PROBE_COMPLETION_REASONS,
      `${path}.completion_reason`,
    );
  const result = value.result === null ? null : createProbeResult(value.result, `${path}.result`);
  const error = value.error === null ? null : createProbeError(value.error, `${path}.error`);
  const pendingEntries = history.filter((entry) => entry.answer === null);
  if (pendingEntries.length > 1 || (pendingEntries.length === 1 && history.at(-1) !== pendingEntries[0])) {
    fail("invalid_session", `${path}.history pode conter somente uma pergunta pendente ao final.`);
  }
  if (status === "active" && (completionReason !== null || result !== null || error !== null)) {
    fail("invalid_session", `${path} ativa não pode estar concluída ou com erro.`);
  }
  if (status === "active" && (currentConcept === null || pendingEntries.length !== 1)) {
    fail("invalid_session", `${path} ativa deve possuir uma pergunta atual pendente.`);
  }
  if (status === "completed" && (completionReason === null || result === null || error !== null)) {
    fail("invalid_session", `${path} concluída deve possuir resultado e completion_reason.`);
  }
  if (status === "completed" && (currentConcept !== null || pendingEntries.length !== 0)) {
    fail("invalid_session", `${path} concluída não pode possuir pergunta atual.`);
  }
  if (status === "error" && (completionReason !== "llm_failure" || error === null || result !== null)) {
    fail("invalid_session", `${path} com erro deve expor somente falha sanitizada.`);
  }
  const createdAt = timestamp(value.created_at, `${path}.created_at`);
  const updatedAt = timestamp(value.updated_at, `${path}.updated_at`);
  if (updatedAt < createdAt) {
    fail("invalid_session", `${path}.updated_at não pode ser anterior a created_at.`);
  }

  return deepFreeze({
    id: string(value.id, `${path}.id`),
    learning_goal: string(value.learning_goal, `${path}.learning_goal`),
    primary_concepts: primaryConcepts,
    target_concepts: targetConcepts,
    evaluated_concepts: evaluatedConcepts,
    current_concept: currentConcept,
    current_difficulty: integer(
      value.current_difficulty,
      `${path}.current_difficulty`,
      { min: 1, max: 5 },
    ),
    question_count: questionCount,
    max_questions: maxQuestions,
    status,
    learner_state: createLearnerState(value.learner_state, `${path}.learner_state`),
    history,
    completion_reason: completionReason,
    result,
    error,
    policy_version: string(value.policy_version, `${path}.policy_version`),
    created_at: createdAt,
    updated_at: updatedAt,
  });
}
