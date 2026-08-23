import { ADAPTIVE_ACTIONS } from "../adaptive-decision/index.js";
import {
  EVIDENCE_STRENGTHS,
  EVALUATION_EVIDENCE_SOURCES,
  MASTERY_DIRECTIONS,
  MISCONCEPTION_STATUSES,
} from "../domain/index.js";
import {
  REASONING_QUALITIES,
  UNDERSTANDING_LEVELS,
} from "./contracts.js";

const nonEmptyString = Object.freeze({ type: "string", minLength: 1 });

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

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

const masteryEvidence = strictObject({
  concept: nonEmptyString,
  direction: { type: "string", enum: [...MASTERY_DIRECTIONS] },
  strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  reason: nonEmptyString,
});

export const EVALUATOR_LLM_OUTPUT_SCHEMA = Object.freeze(strictObject({
  pedagogical_assessment: strictObject({
    understanding: { type: "string", enum: [...UNDERSTANDING_LEVELS] },
    reasoning_quality: { type: "string", enum: [...REASONING_QUALITIES] },
    conceptual_errors: { type: "array", items: conceptualError },
    misconceptions: { type: "array", items: misconception },
    positive_evidence: { type: "array", items: evaluationEvidence },
    negative_evidence: { type: "array", items: evaluationEvidence },
    prerequisites_to_revisit: {
      type: "array",
      items: nonEmptyString,
      uniqueItems: true,
    },
  }),
  feedback: strictObject({
    message_to_learner: nonEmptyString,
    hints: { type: "array", items: nonEmptyString },
  }),
  mastery_evidence: { type: "array", items: masteryEvidence },
  suggested_next_action: { type: "string", enum: [...ADAPTIVE_ACTIONS] },
}));
