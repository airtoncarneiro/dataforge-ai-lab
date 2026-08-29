import assert from "node:assert/strict";
import test from "node:test";

import { summarizeB27 } from "../../src/evaluation-fixtures/index.js";

test("B27 resume métricas de qualidade e erros do provider", () => {
  const result = summarizeB27([
    { status: "ok", duration_ms: 100, evaluation: { passed: true, expected_action_match: true, solution_leak_free: true } },
    { status: "ok", duration_ms: 200, evaluation: { passed: false, expected_action_match: false, solution_leak_free: true } },
    { status: "error", duration_ms: 50, error_code: "provider_http_error" },
  ]);
  assert.deepEqual(result, {
    total: 3,
    completed: 2,
    provider_errors: 1,
    passed: 1,
    json_valid: 2,
    expected_action_match: 1,
    solution_leak_free: 2,
    average_latency_ms: 150,
    error_codes: { provider_http_error: 1 },
  });
});
