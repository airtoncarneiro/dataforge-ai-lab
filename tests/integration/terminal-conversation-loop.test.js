import assert from "node:assert/strict";
import test from "node:test";

import { createTutorApplicationFromEnv } from "../../src/orchestrator/index.js";
import { TerminalConversationLoop } from "../../src/terminal/index.js";

class ScriptedIO {
  constructor(lines) {
    this.lines = [...lines];
    this.output = "";
    this.interrupted = false;
  }

  async readLine(prompt = "") {
    this.output += prompt;
    return this.lines.length === 0 ? null : this.lines.shift();
  }

  write(value = "") {
    this.output += `${String(value)}\n`;
  }

  close() {}
}

test("modo demo percorre B13–B18 e valida SQL no PostgreSQL real", async () => {
  const application = await createTutorApplicationFromEnv({
    env: {
      ...process.env,
      SQL_MENTOR_PROBE_MAX_QUESTIONS: "5",
      SQL_MENTOR_TARGET_DIFFICULTY: "medium",
      SQL_MENTOR_SANDBOX_MAX_ROWS: "20",
    },
    demo: true,
  });
  const io = new ScriptedIO([
    "Quero aprender SQL",
    "SELECT projeta as colunas solicitadas.",
    "SELECT escolhe expressões para o resultado.",
    "Eu evitaria SELECT * quando conheço as colunas.",
    "A projeção explícita documenta o resultado.",
    "Eu selecionaria customer_id e name.",
    "SELECT customer_id, name",
    "FROM customers",
    "ORDER BY customer_id",
    ".enviar",
    "sair",
  ]);
  const outcome = await new TerminalConversationLoop({ application, io }).run();

  assert.equal(outcome.reason, "manual_exit");
  assert.match(io.output, /\[PROBE CONCLUÍDO\]/);
  assert.match(io.output, /\[RESULTADO SQL\] status=correct/);
  assert.match(io.output, /Ana Souza/);
  assert.match(io.output, /\[FEEDBACK DO TUTOR\]/);
  assert.match(io.output, /\[PRÓXIMA AÇÃO\] practice/);
  assert.doesNotMatch(
    io.output,
    /reference_query|validation_metadata|OPENAI_API_KEY|postgres:\/\/|stack trace/iu,
  );
  assert.equal(application.session.attempts.length, 1);
  assert.equal(application.session.validations[0].correct, true);
  assert.equal(application.session.evaluations.length, 1);
  assert.equal(application.session.mastery_changes.length > 0, true);
});
