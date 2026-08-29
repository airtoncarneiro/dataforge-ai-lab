import { createLearnerState } from "../domain/index.js";
export const APPLY_READINESS_POLICY_VERSION = "apply-readiness-policy-v1";
export function assessApplyReadiness({ learnerState, currentConcept, minConcepts = 2 }) {
  const state = createLearnerState(learnerState);
  if (!Number.isSafeInteger(minConcepts) || minConcepts < 2) throw new TypeError("minConcepts deve ser inteiro maior ou igual a 2.");
  const operational = state.concepts.filter((item) => item.mastery >= 0.8 && item.confidence !== "low" && item.misconceptions.every((m) => m.status === "resolved") && item.evidence_ids.length > 0);
  const current = operational.find((item) => item.concept === currentConcept);
  if (!current || operational.length < minConcepts) return null;
  const selected = [current, ...operational.filter((item) => item.concept !== currentConcept).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.concept.localeCompare(b.concept))].slice(0, 3);
  return Object.freeze({ target_concepts: Object.freeze(selected.map((item) => item.concept)), integration_concepts: Object.freeze(selected.slice(1).map((item) => item.concept)), evidence_ids: Object.freeze(selected.flatMap((item) => item.evidence_ids).slice(0, 12)), policy_version: APPLY_READINESS_POLICY_VERSION });
}
