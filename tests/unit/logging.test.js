import assert from "node:assert/strict";
import test from "node:test";

import { FakeLlmProvider, LlmAdapter } from "../../src/llm/index.js";
import {
  ConsoleJsonLogger,
  InMemoryLogger,
  LOG_LEVELS,
  NullLogger,
  createLogEvent,
  emitSafely,
  redact,
  sqlFingerprint,
} from "../../src/logging/index.js";

test("B20 produz JSON estruturado, versionado e com timestamp UTC", () => {
  const lines = [];
  const logger = new ConsoleJsonLogger({ write: (line) => lines.push(line) });
  logger.log({
    timestamp: "2026-08-23T12:00:00.000Z",
    level: "info",
    event_name: "session.started",
    policy_version: "terminal-application-policy-v1",
    correlation: { session_id: "session-1" },
    operation: { status: "started" },
  });
  const event = JSON.parse(lines[0]);
  assert.equal(event.timestamp, "2026-08-23T12:00:00.000Z");
  assert.equal(event.schema_version, "log-event-v1");
  assert.equal(event.correlation.session_id, "session-1");
  assert.deepEqual(LOG_LEVELS, ["debug", "info", "warn", "error"]);
});

test("B20 centraliza redaction, hash de SQL e falha de sink inofensiva", () => {
  const unsafe = redact({
    OPENAI_API_KEY: "sk-secret-123456789",
    connection_string: "postgresql://user:password@db/internal",
    reference_query: "SELECT secret",
    reference_solution: "SELECT answer",
    trusted_validation_metadata: { reference_query: "SELECT x" },
    sql: "SELECT * FROM customers",
  });
  assert.deepEqual(unsafe, {
    OPENAI_API_KEY: "[REDACTED]",
    connection_string: "[REDACTED]",
    reference_query: "[REDACTED]",
    reference_solution: "[REDACTED]",
    trusted_validation_metadata: "[REDACTED]",
    sql: "[REDACTED]",
  });
  assert.match(sqlFingerprint("SELECT * FROM customers"), /^[a-f0-9]{24}$/u);
  assert.doesNotThrow(() => emitSafely({ log() { throw new Error("sink down"); } }, {
    event_name: "session.started",
  }));
  new NullLogger().log(createLogEvent({ event_name: "session.started" }));
});

test("B20 registra request LLM normal e falha sem prompt ou segredo", async () => {
  const logger = new InMemoryLogger();
  const adapter = new LlmAdapter({
    provider: new FakeLlmProvider({ scenarios: [{ type: "valid", output: { answer: "ok" }, requestId: "llm-1" }] }),
    policyVersion: "policy-v1",
    logger,
  });
  const result = await adapter.generate({
    instructions: "test-only-instructions",
    messages: [{ role: "user", content: "SELECT * FROM hidden" }],
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  });
  assert.equal(result.status, "ok");
  const event = logger.events.at(-1);
  assert.equal(event.event_name, "llm.request.completed");
  assert.equal(event.correlation.llm_request_id, "llm-1");
  assert.doesNotMatch(JSON.stringify(event), /test-only-instructions|SELECT \* FROM hidden|instructions|messages/iu);

  const failingLogger = new InMemoryLogger();
  const failingAdapter = new LlmAdapter({
    provider: new FakeLlmProvider({ scenarios: [{ type: "timeout" }] }),
    policyVersion: "policy-v1",
    timeoutMs: 1,
    maxRetries: 0,
    logger: failingLogger,
  });
  const failed = await failingAdapter.generate({
    instructions: "safe",
    messages: [],
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  assert.equal(failed.status, "error");
  assert.equal(failingLogger.events.at(-1).event_name, "llm.request.failed");
  assert.equal(failingLogger.events.at(-1).error.category, "timeout");
});
