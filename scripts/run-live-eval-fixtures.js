import { readFile } from "node:fs/promises";

import { createLlmAdapterFromEnv } from "../src/llm/index.js";
import { evaluateFixture, summarizeB27 } from "../src/evaluation-fixtures/index.js";

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
const schema = {
  type: "object", additionalProperties: false,
  required: ["next_action", "message_to_learner", "hints", "misconceptions"],
  properties: {
    next_action: {
      type: "string",
      enum: ["retry", "reteach", "practice", "advance", "review"],
      description: "A única ação pedagógica recomendada com base nas evidências da tentativa.",
    },
    message_to_learner: {
      type: "string",
      minLength: 1,
      description: "Feedback curto para o aluno, sem SQL, sem solução e sem bloco de código.",
    },
    hints: {
      type: "array",
      description: "Dicas graduais que orientam sem revelar a consulta SQL correta.",
      items: { type: "string" },
    },
    misconceptions: {
      type: "array",
      description: "Conceitos ou raciocínios incorretos observados na tentativa; vazio quando não houver evidência.",
      items: { type: "string" },
    },
  },
};

const fixtures = selectedFixtures(JSON.parse(await readFile(fixtureUrl, "utf8")));
const adapter = createLlmAdapterFromEnv(process.env);
const delayMs = Math.max(0, Number(process.env.LLM_EVAL_DELAY_MS ?? 0) || 0);
const records = [];
for (const fixture of fixtures) {
  const requestStarted = Date.now();
  let response;
  try {
    response = await adapter.generate({
      instructions: "Você é avaliador pedagógico de SQL. Não escreva SQL, não revele solução e responda somente o schema solicitado.",
      messages: [{ role: "user", content: JSON.stringify({ kind: "evaluation_fixture", fixture }) }],
      outputSchema: schema,
      tools: [],
    });
  } catch (error) {
    response = { status: "error", error: { code: error?.code ?? "provider_error" } };
  }
  const evaluation = response.status === "ok"
    ? evaluateFixture(fixture, response.output)
    : { id: fixture.id, passed: false, failures: [response.error?.code ?? "provider_error"] };
  const record = {
    id: fixture.id,
    status: response.status,
    duration_ms: Date.now() - requestStarted,
    error_code: response.error?.code ?? null,
    http_status: response.error?.http_status ?? null,
    evaluation,
  };
  records.push(record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (delayMs > 0 && fixture !== fixtures.at(-1)) await new Promise((resolve) => setTimeout(resolve, delayMs));
}
const summary = summarizeB27(records);
process.stdout.write(`${JSON.stringify({ ...summary, elapsed_ms: Date.now() - started })}\n`);
process.exitCode = summary.provider_errors > 0 || summary.passed !== summary.total ? 1 : 0;
