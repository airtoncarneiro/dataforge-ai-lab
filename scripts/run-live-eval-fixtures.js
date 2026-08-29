import { readFile } from "node:fs/promises";

import { createLlmAdapterFromEnv } from "../src/llm/index.js";
import { evaluateFixture } from "../src/evaluation-fixtures/index.js";

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

const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
const adapter = createLlmAdapterFromEnv(process.env);
const results = [];
for (const fixture of fixtures) {
  const response = await adapter.generate({
    instructions: "Você é avaliador pedagógico de SQL. Não escreva SQL, não revele solução e responda somente o schema solicitado.",
    messages: [{ role: "user", content: JSON.stringify({ kind: "evaluation_fixture", fixture }) }],
    outputSchema: schema,
    tools: [],
  });
  const result = response.status === "ok"
    ? evaluateFixture(fixture, response.output)
    : { id: fixture.id, passed: false, failures: [response.error?.code ?? "provider_error"] };
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
const failed = results.filter((result) => !result.passed);
process.stdout.write(`${JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length })}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
