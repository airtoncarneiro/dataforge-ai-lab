import {
  EVIDENCE_STRENGTHS,
  MASTERY_DIRECTIONS,
  MISCONCEPTION_STATUSES,
} from "../domain/index.js";
import { PROBE_QUESTION_TYPES } from "./contracts.js";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const nonEmptyString = { type: "string", minLength: 1 };
const conceptArray = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: nonEmptyString,
};

export const PROBE_MASTERY_EVIDENCE_SCHEMA = deepFreeze(strictObject({
  concept: nonEmptyString,
  direction: { type: "string", enum: [...MASTERY_DIRECTIONS] },
  strength: { type: "string", enum: [...EVIDENCE_STRENGTHS] },
  reason: nonEmptyString,
}));

export const PROBE_QUESTION_OUTPUT_SCHEMA = deepFreeze(strictObject({
  question: nonEmptyString,
  targets: conceptArray,
  difficulty: { type: "integer", minimum: 1, maximum: 5 },
  question_type: { type: "string", enum: [...PROBE_QUESTION_TYPES] },
  reason: nonEmptyString,
}));

export const PROBE_EVALUATION_OUTPUT_SCHEMA = deepFreeze(strictObject({
  assessment: strictObject({
    correct: { type: "boolean" },
    conceptual_errors: {
      type: "array",
      items: strictObject({
        code: nonEmptyString,
        concept: nonEmptyString,
        description: nonEmptyString,
      }),
    },
    misconceptions: {
      type: "array",
      items: strictObject({
        concept: nonEmptyString,
        description: nonEmptyString,
        status: { type: "string", enum: [...MISCONCEPTION_STATUSES] },
        evidence: nonEmptyString,
      }),
    },
    prerequisites_to_revisit: {
      type: "array",
      uniqueItems: true,
      items: nonEmptyString,
    },
  }),
  mastery_evidence: {
    type: "array",
    minItems: 1,
    items: PROBE_MASTERY_EVIDENCE_SCHEMA,
  },
  rationale: nonEmptyString,
}));
