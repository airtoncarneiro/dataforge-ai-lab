import { createLearnerState } from "../domain/index.js";

export const REVIEW_SCHEDULER_POLICY_VERSION = "review-scheduler-policy-v1";

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} deve ser uma string não vazia.`);
  return value;
}

function evidenceCount(state) {
  return state.evidence_summary.positive_attempts + state.evidence_summary.negative_attempts;
}

function hasActiveMisconception(state) {
  return state.misconceptions.some((item) => item.status !== "resolved");
}

// Selects the current concept plus previously evidenced concepts. This keeps a
// review cumulative while avoiding concepts that still need re-teaching.
export function scheduleReview({ learnerState, currentConcept, maxTargets = 3 }) {
  const state = createLearnerState(learnerState);
  const current = requiredString(currentConcept, "currentConcept");
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 5) {
    throw new TypeError("maxTargets deve ser inteiro entre 1 e 5.");
  }
  const currentState = state.concepts.find((item) => item.concept === current);
  if (!currentState) throw new TypeError("currentConcept deve existir no LearnerState.");

  const earlier = state.concepts
    .filter((item) => item.concept !== current)
    .filter((item) => item.mastery >= 0.8 && item.confidence !== "low")
    .filter((item) => evidenceCount(item) > 0 && !hasActiveMisconception(item))
    .sort((left, right) => (
      left.updated_at.localeCompare(right.updated_at)
      || left.mastery - right.mastery
      || left.concept.localeCompare(right.concept)
    ));
  const targets = Object.freeze([current, ...earlier.slice(0, maxTargets - 1).map((item) => item.concept)]);
  return Object.freeze({
    current_concept: current,
    review_targets: targets,
    integration_concepts: Object.freeze(targets.slice(1)),
    policy_version: REVIEW_SCHEDULER_POLICY_VERSION,
  });
}
