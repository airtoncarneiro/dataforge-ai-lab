import assert from "node:assert/strict";
import test from "node:test";

import {
  SOCRATIC_RETRY_POLICY_VERSION,
  createSocraticRetry,
} from "../../src/orchestrator/socratic-retry-policy.js";

test("primeiro retry técnico pede autocorreção antes de oferecer pista", () => {
  const result = createSocraticRetry({
    executionError: { category: "syntax_error" },
    retryCount: 0,
    evaluatorHints: ["Esta pista não deve aparecer ainda."],
  });
  assert.equal(result.stage, "question");
  assert.match(result.message, /sintaxe/u);
  assert.equal(result.retry_number, 1);
  assert.equal(result.policy_version, SOCRATIC_RETRY_POLICY_VERSION);
  assert.equal(Object.isFrozen(result), true);
});

test("segundo retry técnico libera somente a primeira pista aprovada", () => {
  const result = createSocraticRetry({
    executionError: { category: "execution_error" },
    retryCount: 1,
    evaluatorHints: ["Confira o nome da coluna.", "Não exiba esta segunda pista."],
  });
  assert.equal(result.stage, "hint");
  assert.equal(result.message, "Confira o nome da coluna.");
  assert.equal(result.retry_number, 2);
});

test("pista possui fallback seguro e não aceita entradas inválidas", () => {
  const result = createSocraticRetry({
    executionError: { category: "timeout" }, retryCount: 1,
  });
  assert.match(result.message, /versão menor/u);
  assert.throws(
    () => createSocraticRetry({ executionError: { category: "syntax_error" }, retryCount: -1 }),
    /retryCount/u,
  );
});
