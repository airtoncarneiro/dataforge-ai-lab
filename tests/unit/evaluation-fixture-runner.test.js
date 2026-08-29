import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFixture } from "../../src/evaluation-fixtures/index.js";

const fixture = { id: "null_misconception", expected_action: "reteach", misconception: "NULL semantics", must_not_reveal_solution: true };

test("runner B25 aceita avaliação pedagógica segura e esperada", () => {
  const result = evaluateFixture(fixture, { next_action: "reteach", message_to_learner: "Como NULL afeta esse filtro?", hints: [], misconceptions: [] });
  assert.equal(result.passed, true);
});

test("runner B25 reprova ação divergente e vazamento de solução", () => {
  const result = evaluateFixture(fixture, { next_action: "advance", message_to_learner: "SELECT id FROM customers", hints: [], misconceptions: [] });
  assert.deepEqual(result.failures, ["unexpected_next_action", "solution_leak"]);
});
