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
import { deepFreeze } from "./validation.js";

const nonEmptyString = { type: "string", minLength: 1 };
const nullableString = { anyOf: [nonEmptyString, { type: "null" }] };
const timestamp = { type: "string", format: "date-time" };
const stringArray = { type: "array", items: nonEmptyString, uniqueItems: true };
const mastery = { type: "number", minimum: 0, maximum: 1 };

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export const EVIDENCE_DETAIL_SCHEMA = deepFreeze(strictObject({
  key: nonEmptyString,
  value: {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
    ],
  },
}));

export const EVALUATION_EVIDENCE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  source: { type: "string", enum: [...EVALUATION_EVIDENCE_SOURCES] },
  description: nonEmptyString,
  details: { type: "array", items: EVIDENCE_DETAIL_SCHEMA },
  observed_at: timestamp,
}));

export const MISCONCEPTION_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  concept: nonEmptyString,
  description: nonEmptyString,
  status: { type: "string", enum: [...MISCONCEPTION_STATUSES] },
  evidence_ids: stringArray,
  observed_at: timestamp,
}));

export const CONCEPTUAL_ERROR_SCHEMA = deepFreeze(strictObject({
  code: nonEmptyString,
  concept: nonEmptyString,
  description: nonEmptyString,
}));

export const EXECUTION_ERROR_SCHEMA = deepFreeze(strictObject({
  category: { type: "string", enum: [...EXECUTION_ERROR_CATEGORIES] },
  sqlstate: {
    anyOf: [
      { type: "string", pattern: "^[0-9A-Z]{5}$" },
      { type: "null" },
    ],
  },
  message: nonEmptyString,
}));

export const FEEDBACK_SCHEMA = deepFreeze(strictObject({
  message_to_learner: nonEmptyString,
  hints: stringArray,
}));

export const CONCEPT_STATE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  concept: nonEmptyString,
  mastery,
  confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
  misconceptions: { type: "array", items: MISCONCEPTION_SCHEMA },
  evidence_ids: stringArray,
  created_at: timestamp,
  updated_at: timestamp,
}));

export const LEARNER_STATE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  session_id: nonEmptyString,
  learning_goal: nonEmptyString,
  concepts: { type: "array", items: CONCEPT_STATE_SCHEMA },
  created_at: timestamp,
  updated_at: timestamp,
}));

export const LEARNING_SESSION_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  learning_goal: nonEmptyString,
  phase: { type: "string", enum: [...SESSION_PHASES] },
  learner_state_id: nonEmptyString,
  current_exercise_id: nullableString,
  created_at: timestamp,
  updated_at: timestamp,
}));

export const EXERCISE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  concepts: { ...stringArray, minItems: 1 },
  difficulty: { type: "integer", minimum: 1 },
  objective: nonEmptyString,
  statement: nonEmptyString,
  expected_skills: { ...stringArray, minItems: 1 },
  validation_strategy: { type: "string", enum: [...VALIDATION_STRATEGIES] },
  evaluation_notes: { type: "array", items: nonEmptyString },
  reference_solution: nullableString,
  created_at: timestamp,
}));

export const ATTEMPT_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  session_id: nonEmptyString,
  exercise_id: nonEmptyString,
  submission: nonEmptyString,
  execution_evidence_id: nullableString,
  submitted_at: timestamp,
}));

export const EXECUTION_EVIDENCE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  attempt_id: nonEmptyString,
  status: { type: "string", enum: [...EXECUTION_STATUSES] },
  columns: { type: "array", items: nonEmptyString },
  rows: { type: "array", items: {} },
  row_count: { type: "integer", minimum: 0 },
  truncated: { type: "boolean" },
  duration_ms: { type: "number", minimum: 0 },
  error: { anyOf: [EXECUTION_ERROR_SCHEMA, { type: "null" }] },
  explain: {},
  created_at: timestamp,
}));

export const ASSESSMENT_SCHEMA = deepFreeze(strictObject({
  correct: { type: "boolean" },
  execution_error: { anyOf: [EXECUTION_ERROR_SCHEMA, { type: "null" }] },
  conceptual_errors: { type: "array", items: CONCEPTUAL_ERROR_SCHEMA },
  misconceptions: { type: "array", items: MISCONCEPTION_SCHEMA },
  positive_evidence: { type: "array", items: EVALUATION_EVIDENCE_SCHEMA },
  negative_evidence: { type: "array", items: EVALUATION_EVIDENCE_SCHEMA },
  prerequisites_to_revisit: stringArray,
}));

export const MASTERY_EVIDENCE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  attempt_id: nonEmptyString,
  concept: nonEmptyString,
  direction: { type: "string", enum: [...MASTERY_DIRECTIONS] },
  strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  reason: nonEmptyString,
  observed_at: timestamp,
}));

export const EVALUATION_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  attempt_id: nonEmptyString,
  exercise_id: nonEmptyString,
  assessment: ASSESSMENT_SCHEMA,
  feedback: FEEDBACK_SCHEMA,
  mastery_evidence: { type: "array", items: MASTERY_EVIDENCE_SCHEMA },
  next_action: { type: "string", enum: [...NEXT_ACTIONS] },
  evaluated_at: timestamp,
}));

export const MASTERY_CHANGE_SCHEMA = deepFreeze(strictObject({
  id: nonEmptyString,
  concept_state_id: nonEmptyString,
  attempt_id: nonEmptyString,
  previous_mastery: mastery,
  new_mastery: mastery,
  previous_confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
  new_confidence: { type: "string", enum: [...CONFIDENCE_LEVELS] },
  mastery_evidence_ids: { ...stringArray, minItems: 1 },
  policy_version: nonEmptyString,
  changed_at: timestamp,
}));

export const DOMAIN_SCHEMAS = deepFreeze({
  LearningSession: LEARNING_SESSION_SCHEMA,
  ConceptState: CONCEPT_STATE_SCHEMA,
  LearnerState: LEARNER_STATE_SCHEMA,
  Exercise: EXERCISE_SCHEMA,
  Attempt: ATTEMPT_SCHEMA,
  ExecutionEvidence: EXECUTION_EVIDENCE_SCHEMA,
  Assessment: ASSESSMENT_SCHEMA,
  Evaluation: EVALUATION_SCHEMA,
  MasteryEvidence: MASTERY_EVIDENCE_SCHEMA,
  MasteryChange: MASTERY_CHANGE_SCHEMA,
});
