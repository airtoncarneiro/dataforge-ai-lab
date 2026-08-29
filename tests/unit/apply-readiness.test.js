import assert from "node:assert/strict";
import test from "node:test";
import { assessApplyReadiness } from "../../src/apply/index.js";

function concept(conceptName, updatedAt, { mastery = 0.9, confidence = "medium", evidenceIds = ["evidence:1"] } = {}) {
  return { id: `concept:${conceptName}`, concept: conceptName, mastery, confidence, misconceptions: [], evidence_ids: evidenceIds,
    evidence_summary: { positive_attempts: 2, negative_attempts: 0, consecutive_positive: 2, consecutive_negative: 0 },
    created_at: "2026-01-01T00:00:00.000Z", updated_at: updatedAt };
}
function state(concepts) {
  return { id: "learner:apply", session_id: "session:apply", learning_goal: "SQL", concepts,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-04T00:00:00.000Z" };
}

test("B23 libera APPLY somente com dois conceitos operacionais e evidenciados", () => {
  const result = assessApplyReadiness({ learnerState: state([
    concept("select", "2026-01-02T00:00:00.000Z", { evidenceIds: ["evidence:select"] }),
    concept("where", "2026-01-03T00:00:00.000Z", { evidenceIds: ["evidence:where"] }),
  ]), currentConcept: "where" });
  assert.deepEqual(result.target_concepts, ["where", "select"]);
  assert.deepEqual(result.integration_concepts, ["select"]);
  assert.deepEqual(result.evidence_ids, ["evidence:where", "evidence:select"]);
});

test("B23 não libera APPLY com evidência ou domínio insuficiente", () => {
  assert.equal(assessApplyReadiness({ learnerState: state([
    concept("select", "2026-01-02T00:00:00.000Z"),
    concept("where", "2026-01-03T00:00:00.000Z", { evidenceIds: [] }),
  ]), currentConcept: "where" }), null);
});
