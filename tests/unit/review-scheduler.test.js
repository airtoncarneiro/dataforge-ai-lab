import assert from "node:assert/strict";
import test from "node:test";
import { scheduleReview } from "../../src/review/index.js";

const learnerState = {
  id: "learner:review", session_id: "session:review", learning_goal: "SQL",
  concepts: [
    { id: "a", concept: "select", mastery: 0.9, confidence: "high", misconceptions: [], evidence_ids: [], evidence_summary: { positive_attempts: 2, negative_attempts: 0, consecutive_positive: 2, consecutive_negative: 0 }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
    { id: "b", concept: "where", mastery: 0.9, confidence: "medium", misconceptions: [], evidence_ids: [], evidence_summary: { positive_attempts: 2, negative_attempts: 0, consecutive_positive: 2, consecutive_negative: 0 }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z" },
    { id: "c", concept: "order_by", mastery: 0.9, confidence: "medium", misconceptions: [], evidence_ids: [], evidence_summary: { positive_attempts: 2, negative_attempts: 0, consecutive_positive: 2, consecutive_negative: 0 }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-04T00:00:00.000Z" },
  ],
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-04T00:00:00.000Z",
};

test("B22 seleciona revisão cumulativa com o foco atual e conceitos anteriores", () => {
  const plan = scheduleReview({ learnerState, currentConcept: "order_by" });
  assert.deepEqual(plan.review_targets, ["order_by", "select", "where"]);
  assert.deepEqual(plan.integration_concepts, ["select", "where"]);
  assert.equal(Object.isFrozen(plan), true);
});
