export const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);

export const SESSION_PHASES = Object.freeze([
  "PROBE",
  "PLAN",
  "TEACH",
  "PRACTICE",
  "EVALUATE",
  "ADAPT",
  "REVIEW",
  "APPLY",
  "TRANSFER_TEST",
  "COMPLETE",
]);

export const NEXT_ACTIONS = Object.freeze([
  "continue_probe",
  "teach",
  "retry",
  "reteach",
  "practice",
  "advance",
  "review",
  "apply",
  "transfer_test",
  "complete",
]);

export const VALIDATION_STRATEGIES = Object.freeze([
  "RESULT_SET",
  "ORDERED_RESULT",
  "PROPERTY_BASED",
  "PLAN_CONSTRAINT",
  "MANUAL_LLM_REVIEW",
]);

export const MASTERY_DIRECTIONS = Object.freeze(["up", "down"]);
export const EVIDENCE_STRENGTHS = Object.freeze(["weak", "medium", "strong"]);
export const MISCONCEPTION_STATUSES = Object.freeze(["suspected", "confirmed", "resolved"]);

export const EVALUATION_EVIDENCE_SOURCES = Object.freeze([
  "execution",
  "validation",
  "query_structure",
  "explain",
  "historical",
]);

export const EXECUTION_STATUSES = Object.freeze(["ok", "error"]);
export const EXECUTION_ERROR_CATEGORIES = Object.freeze([
  "syntax_error",
  "security_violation",
  "timeout",
  "execution_error",
]);
