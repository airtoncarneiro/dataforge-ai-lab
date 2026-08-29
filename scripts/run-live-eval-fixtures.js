import { readFile } from "node:fs/promises";

import { createLlmAdapterFromEnv } from "../src/llm/index.js";
import {
  evaluateFixture,
  LIVE_EVALUATION_INSTRUCTIONS,
  LIVE_EVALUATION_OUTPUT_SCHEMA,
  liveEvaluationAdapterEnv,
  outputFormatCorrectionMessage,
  shouldRetryLiveFormatError,
  solutionLeakCorrectionMessage,
  summarizeB27,
} from "../src/evaluation-fixtures/index.js";

async function loadDotEnv() {
  try {
    const content = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* .env is optional when CI injects variables */ }
}

function selectedFixtures(fixtures) {
  const index = process.argv.indexOf("--fixture");
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) return fixtures;
  const selected = fixtures.filter((fixture) => fixture.id === value);
  if (selected.length === 0) throw new Error(`Fixture B25 não encontrado: ${value}`);
  return selected;
}

const started = Date.now();
await loadDotEnv();

const fixtureUrl = new URL("../tests/fixtures/llm-evaluation/b25-evaluation-fixtures.json", import.meta.url);
const fixtures = selectedFixtures(JSON.parse(await readFile(fixtureUrl, "utf8")));
const adapter = createLlmAdapterFromEnv(liveEvaluationAdapterEnv(process.env));
const delayMs = Math.max(0, Number(process.env.LLM_EVAL_DELAY_MS ?? 0) || 0);
const records = [];
for (const fixture of fixtures) {
  const requestStarted = Date.now();
  const instructions = LIVE_EVALUATION_INSTRUCTIONS;
  const messages = [{ role: "user", content: JSON.stringify({ kind: "evaluation_fixture", fixture }) }];
  let response;
  try {
    response = await adapter.generate({
      instructions,
      messages,
      outputSchema: LIVE_EVALUATION_OUTPUT_SCHEMA,
      tools: [],
    });
  } catch (error) {
    response = { status: "error", error: { code: error?.code ?? "provider_error" } };
  }
  let formatAttempts = 1;
  if (response.status === "error" && shouldRetryLiveFormatError(response.error?.code)) {
    formatAttempts += 1;
    response = await adapter.generate({
      instructions,
      messages: [...messages, { role: "user", content: outputFormatCorrectionMessage() }],
      outputSchema: LIVE_EVALUATION_OUTPUT_SCHEMA,
      tools: [],
    });
  }
  let semanticAttempts = 1;
  let evaluation = response.status === "ok"
    ? evaluateFixture(fixture, response.output)
    : { id: fixture.id, passed: false, failures: [response.error?.code ?? "provider_error"] };
  if (response.status === "ok" && evaluation.failures.includes("solution_leak")) {
    semanticAttempts += 1;
    response = await adapter.generate({
      instructions,
      messages: [...messages, {
        role: "user",
        content: solutionLeakCorrectionMessage(),
      }],
      outputSchema: LIVE_EVALUATION_OUTPUT_SCHEMA,
      tools: [],
    });
    evaluation = response.status === "ok"
      ? evaluateFixture(fixture, response.output)
      : { id: fixture.id, passed: false, failures: [response.error?.code ?? "provider_error"] };
  }
  const record = {
    id: fixture.id,
    status: response.status,
    duration_ms: Date.now() - requestStarted,
    error_code: response.error?.code ?? null,
    http_status: response.error?.http_status ?? null,
    format_attempts: formatAttempts,
    semantic_attempts: semanticAttempts,
    evaluation,
  };
  records.push(record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (delayMs > 0 && fixture !== fixtures.at(-1)) await new Promise((resolve) => setTimeout(resolve, delayMs));
}
const summary = summarizeB27(records);
process.stdout.write(`${JSON.stringify({ ...summary, elapsed_ms: Date.now() - started })}\n`);
process.exitCode = summary.provider_errors > 0 || summary.passed !== summary.total ? 1 : 0;
