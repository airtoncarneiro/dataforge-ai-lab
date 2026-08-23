import {
  EVIDENCE_STRENGTHS,
  EVALUATION_EVIDENCE_SOURCES,
  EXECUTION_ERROR_CATEGORIES,
  MASTERY_DIRECTIONS,
  MISCONCEPTION_STATUSES,
  NEXT_ACTIONS,
} from "../domain/index.js";
import { TASK_BY_PHASE } from "./policy-manifest.js";
import { deepFreeze, fail } from "./utils.js";

const nonEmptyString = { type: "string", minLength: 1 };
const stringArray = { type: "array", items: nonEmptyString, uniqueItems: true };
const nextAction = { type: "string", enum: [...NEXT_ACTIONS] };

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const masteryEvidence = strictObject({
  concept: nonEmptyString,
  direction: { type: "string", enum: [...MASTERY_DIRECTIONS] },
  strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  reason: nonEmptyString,
});

const executionError = strictObject({
  category: { type: "string", enum: [...EXECUTION_ERROR_CATEGORIES] },
  sqlstate: { anyOf: [{ type: "string", pattern: "^[0-9A-Z]{5}$" }, { type: "null" }] },
  message: nonEmptyString,
});

const conceptualError = strictObject({
  code: nonEmptyString,
  concept: nonEmptyString,
  description: nonEmptyString,
});

const misconception = strictObject({
  concept: nonEmptyString,
  description: nonEmptyString,
  status: { type: "string", enum: [...MISCONCEPTION_STATUSES] },
  evidence: nonEmptyString,
});

const evaluationEvidence = strictObject({
  concept: nonEmptyString,
  description: nonEmptyString,
  source: { type: "string", enum: [...EVALUATION_EVIDENCE_SOURCES] },
});

const schemasByTask = {
  probe: strictObject({
    message_to_learner: nonEmptyString,
    question: nonEmptyString,
    targets: { ...stringArray, minItems: 1 },
    difficulty: { type: "integer", minimum: 1, maximum: 5 },
    reason: nonEmptyString,
    next_action: nextAction,
  }),
  plan: strictObject({
    message_to_learner: nonEmptyString,
    focus_concepts: { ...stringArray, minItems: 1 },
    sequence_rationale: nonEmptyString,
    next_action: nextAction,
  }),
  teach: strictObject({
    message_to_learner: nonEmptyString,
    concepts: { ...stringArray, minItems: 1 },
    comprehension_check: nonEmptyString,
    next_action: nextAction,
  }),
  practice: strictObject({
    message_to_learner: nonEmptyString,
    target_concepts: { ...stringArray, minItems: 1 },
    retrieval_prompt: nonEmptyString,
    next_action: nextAction,
  }),
  evaluate: strictObject({
    message_to_learner: nonEmptyString,
    assessment: strictObject({
      correct: { type: "boolean" },
      execution_error: { anyOf: [executionError, { type: "null" }] },
      conceptual_errors: { type: "array", items: conceptualError },
      misconceptions: { type: "array", items: misconception },
      positive_evidence: { type: "array", items: evaluationEvidence },
      negative_evidence: { type: "array", items: evaluationEvidence },
      prerequisites_to_revisit: stringArray,
    }),
    mastery_evidence: { type: "array", items: masteryEvidence },
    next_action: nextAction,
  }),
  adapt: strictObject({
    message_to_learner: nonEmptyString,
    mastery_evidence: { type: "array", items: masteryEvidence },
    next_action: nextAction,
    rationale: nonEmptyString,
  }),
  review: strictObject({
    message_to_learner: nonEmptyString,
    review_targets: { ...stringArray, minItems: 1 },
    retrieval_prompt: nonEmptyString,
    next_action: nextAction,
  }),
  apply: strictObject({
    message_to_learner: nonEmptyString,
    target_concepts: { ...stringArray, minItems: 1 },
    scenario_brief: nonEmptyString,
    success_criteria: { ...stringArray, minItems: 1 },
    next_action: nextAction,
  }),
  transfer_test: strictObject({
    message_to_learner: nonEmptyString,
    principles_to_transfer: { ...stringArray, minItems: 1 },
    new_context_brief: nonEmptyString,
    success_criteria: { ...stringArray, minItems: 1 },
    next_action: nextAction,
  }),
  complete: strictObject({
    message_to_learner: nonEmptyString,
    mastered_concepts: stringArray,
    partial_concepts: stringArray,
    gaps: stringArray,
    next_recommendations: stringArray,
    next_action: nextAction,
  }),
};

export const TUTOR_OUTPUT_SCHEMAS = deepFreeze(schemasByTask);

export function getTutorOutputSchema(phase) {
  const task = TASK_BY_PHASE[phase];
  if (!task) {
    fail("unsupported_phase", `Fase pedagógica não suportada: ${phase}.`);
  }
  return TUTOR_OUTPUT_SCHEMAS[task];
}
