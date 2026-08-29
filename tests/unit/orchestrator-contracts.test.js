import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationEvent } from "../../src/orchestrator/index.js";

test("contrato aceita evento de prévia SQL sem expor dados trusted", () => {
  const event = createApplicationEvent("preview_execution", {
    status: "ok",
    columns: ["name"],
    rows: [{ name: "Produto" }],
    row_count: 1,
    truncated: false,
    duration_ms: 1.25,
    error: null,
  });

  assert.equal(event.type, "preview_execution");
  assert.equal(event.data.rows[0].name, "Produto");
  assert.equal(Object.isFrozen(event), true);
});

test("contrato publica revisão cumulativa sem estado trusted", () => {
  const event = createApplicationEvent("review", {
    message: "Recupere conceitos anteriores.",
    review_targets: ["order_by", "select"],
    policy_version: "review-scheduler-policy-v1",
  });
  assert.equal(event.type, "review");
  assert.deepEqual(event.data.review_targets, ["order_by", "select"]);
});

test("contrato publica Transfer Test sem expor solução ou metadata", () => {
  const event = createApplicationEvent("transfer_test", {
    message: "Aplique os mesmos princípios em outro contexto.",
    target_concepts: ["select", "where"],
    policy_version: "transfer-readiness-policy-v1",
  });
  assert.equal(event.type, "transfer_test");
  assert.deepEqual(event.data.target_concepts, ["select", "where"]);
});
