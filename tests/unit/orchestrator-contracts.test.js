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
