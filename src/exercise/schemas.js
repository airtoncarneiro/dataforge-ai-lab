import { VALIDATION_STRATEGIES } from "../domain/index.js";
import {
  EXERCISE_COMPARISON_MODES,
  VALIDATION_CONSTRAINT_KINDS,
  VALIDATION_CONSTRAINT_OPERATORS,
} from "./contracts.js";

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
const stringArray = {
  type: "array",
  items: nonEmptyString,
  uniqueItems: true,
};
const scalar = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

export const EXERCISE_GENERATION_OUTPUT_SCHEMA = deepFreeze(strictObject({
  id: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9:_-]*$",
  },
  target_concepts: { ...stringArray, minItems: 1 },
  difficulty: { type: "integer", minimum: 1, maximum: 5 },
  objective: { type: "string", minLength: 10 },
  statement: { type: "string", minLength: 40 },
  expected_skills: { ...stringArray, minItems: 1 },
  validation_strategy: {
    type: "string",
    enum: VALIDATION_STRATEGIES.filter((strategy) => strategy !== "MANUAL_LLM_REVIEW"),
  },
  evaluation_notes: { type: "array", items: nonEmptyString },
  validation_metadata: strictObject({
    expected_columns: { ...stringArray, minItems: 1 },
    comparison_mode: { type: "string", enum: [...EXERCISE_COMPARISON_MODES] },
    ordering_required: { type: "boolean" },
    expected_row_count: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
    reference_query: { anyOf: [nonEmptyString, { type: "null" }] },
    concepts_evaluated: { ...stringArray, minItems: 1 },
    source_relations: { ...stringArray, minItems: 1 },
    constraints: {
      type: "array",
      items: strictObject({
        kind: { type: "string", enum: [...VALIDATION_CONSTRAINT_KINDS] },
        target: nonEmptyString,
        operator: { type: "string", enum: [...VALIDATION_CONSTRAINT_OPERATORS] },
        value: scalar,
      }),
    },
  }),
}));

