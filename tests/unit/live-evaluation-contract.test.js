import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_EVALUATION_INSTRUCTIONS,
  LIVE_EVALUATION_OUTPUT_SCHEMA,
  liveEvaluationAdapterEnv,
  outputFormatCorrectionMessage,
  shouldRetryLiveFormatError,
  solutionLeakCorrectionMessage,
} from "../../src/evaluation-fixtures/index.js";

test("B27 usa contrato compacto e limites locais para o output da Gemini", () => {
  assert.equal(LIVE_EVALUATION_OUTPUT_SCHEMA.properties.message_to_learner.maxLength, 280);
  assert.equal(LIVE_EVALUATION_OUTPUT_SCHEMA.properties.hints.maxItems, 2);
  assert.equal(LIVE_EVALUATION_OUTPUT_SCHEMA.properties.misconceptions.maxItems, 2);
  assert.match(LIVE_EVALUATION_INSTRUCTIONS, /somente JSON/iu);
  assert.match(LIVE_EVALUATION_INSTRUCTIONS, /Formato compacto obrigatório/iu);
  assert.match(solutionLeakCorrectionMessage(), /solution_leak/iu);
  assert.match(outputFormatCorrectionMessage(), /output_format/iu);
});

test("B27 regenera somente falhas recuperáveis de formato", () => {
  assert.equal(shouldRetryLiveFormatError("malformed_json"), true);
  assert.equal(shouldRetryLiveFormatError("missing_output"), true);
  assert.equal(shouldRetryLiveFormatError("output_schema_mismatch"), true);
  assert.equal(shouldRetryLiveFormatError("provider_bad_request"), false);
});

test("B27 limita tokens sem alterar o limite geral da aplicação", () => {
  assert.equal(liveEvaluationAdapterEnv({ LLM_MAX_OUTPUT_TOKENS: "1200" }).LLM_MAX_OUTPUT_TOKENS, "320");
  assert.equal(liveEvaluationAdapterEnv({ LLM_EVAL_MAX_OUTPUT_TOKENS: "480" }).LLM_MAX_OUTPUT_TOKENS, "480");
});
