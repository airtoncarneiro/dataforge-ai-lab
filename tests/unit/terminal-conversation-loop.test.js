import assert from "node:assert/strict";
import test from "node:test";

import { TerminalConversationLoop } from "../../src/terminal/index.js";

class ScriptedIO {
  constructor(lines) {
    this.lines = [...lines];
    this.output = "";
    this.interrupted = false;
    this.closed = false;
  }

  async readLine(prompt = "") {
    this.output += prompt;
    return this.lines.length === 0 ? null : this.lines.shift();
  }

  write(value = "") {
    this.output += `${String(value)}\n`;
  }

  close() {
    this.closed = true;
  }
}

function summary(overrides = {}) {
  return {
    id: "session:b18",
    learning_goal: "Quero aprender SQL",
    status: "active",
    phase: "PROBE",
    flow_status: "active",
    current_concept: "select",
    current_exercise_id: null,
    question_count: 1,
    attempt_count: 0,
    retry_count: 0,
    last_action: null,
    policy_version: "terminal-application-policy-v1",
    updated_at: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

const result = (session, events) => ({ session, events });
const event = (type, data) => ({ type, data });

function exerciseEvent(id = "exercise:1", reused = false) {
  return event("exercise", {
    id,
    concepts: ["select"],
    objective: "Projetar colunas solicitadas.",
    statement: "Na relação customers, liste customer_id e name.",
    difficulty: 2,
    expected_skills: ["select"],
    validation_strategy: "RESULT_SET",
    reused,
  });
}

class ScriptedApplication {
  constructor({ action = "practice", validationStatus = "correct", failAt = null } = {}) {
    this.action = action;
    this.validationStatus = validationStatus;
    this.failAt = failAt;
    this.calls = [];
    this.prepareCount = 0;
  }

  async start({ learningGoal }) {
    this.calls.push(["start", learningGoal]);
    return result(summary(), [
      event("welcome", { message: "Diagnóstico antes do ensino." }),
      event("probe_question", { number: 1, max_questions: 5, question: "O que SELECT faz?" }),
    ]);
  }

  async submitProbeAnswer(answer) {
    this.calls.push(["probe", answer]);
    return result(summary({ phase: "PLAN", question_count: 5 }), [
      event("probe_completed", {
        completion_reason: "sufficient_evidence",
        next_concept_recommended: "select",
      }),
      event("progress", {
        concepts: [{ concept: "select", mastery: 0.55, confidence: "low", classification: "partial" }],
      }),
    ]);
  }

  async prepareLearningCycle() {
    this.calls.push(["prepare", this.prepareCount + 1]);
    this.prepareCount += 1;
    if (this.failAt === "llm" && this.prepareCount === 1) {
      return result(summary({ phase: "PLAN" }), [event("error", {
        category: "provider_error",
        code: "provider_failed",
        message: "Conteúdo indisponível.",
        retryable: true,
      })]);
    }
    if (this.prepareCount === 1) {
      return result(summary({ phase: "PRACTICE", current_exercise_id: "exercise:1" }), [
        event("plan", { message: "Plano resumido.", focus_concepts: ["select"], rationale: "Foco atual." }),
        event("teach", { message: "Ensino socrático.", concepts: ["select"], comprehension_check: "Quais colunas?" }),
        exerciseEvent(),
      ]);
    }
    const prefix = this.action === "review"
      ? [event("review_placeholder", { message: "Revisão segura." })]
      : [];
    const id = this.action === "retry" ? "exercise:1" : "exercise:2";
    return result(summary({
      phase: "PRACTICE", current_exercise_id: id, last_action: this.action,
    }), [...prefix, exerciseEvent(id, true)]);
  }

  async submitSql(sql) {
    this.calls.push(["sql", sql]);
    if (this.failAt === "database") throw new Error("internal database stack secret");
    const technical = this.validationStatus === "execution_error";
    const correct = this.validationStatus === "correct";
    const phaseByAction = {
      retry: "PRACTICE", reteach: "TEACH", practice: "PRACTICE", advance: "TEACH", review: "REVIEW",
    };
    return result(summary({
      phase: phaseByAction[this.action],
      current_concept: this.action === "advance" ? "where" : "select",
      current_exercise_id: this.action === "retry" ? "exercise:1" : null,
      attempt_count: 1,
      last_action: this.action,
    }), [
      event("execution", {
        status: this.validationStatus,
        columns: technical ? [] : ["customer_id", "name"],
        rows: technical ? [] : [{ customer_id: 1, name: "Ana" }],
        row_count: technical ? 0 : 1,
        truncated: false,
        duration_ms: 1.25,
        error: technical ? { category: "syntax_error", message: "A consulta contém erro de sintaxe." } : null,
      }),
      event("feedback", {
        correct,
        message: correct ? "Bom resultado objetivo." : "Revise sua consulta.",
        hints: correct ? [] : ["Confira as colunas."],
        conceptual_errors: [], misconceptions: [], source: "llm",
      }),
      event("progress", {
        concepts: [{
          concept: "select", mastery: correct ? 0.62 : 0.48, confidence: "low",
          classification: correct ? "partial" : "insufficient",
        }],
      }),
      event("decision", {
        action: this.action,
        next_concept: this.action === "advance" ? "where" : null,
        rationale: `Decisão ${this.action}.`,
      }),
    ]);
  }

  endSession(reason) {
    this.calls.push(["end", reason]);
    return result(summary({ status: "ended" }), [event("session_ended", {
      reason, message: "Estado descartado da memória.",
    })]);
  }

  async close() {
    this.calls.push(["close"]);
  }
}

async function runLoop({ lines, application = new ScriptedApplication() }) {
  const io = new ScriptedIO(lines);
  const loop = new TerminalConversationLoop({ application, io });
  const outcome = await loop.run();
  return { io, application, outcome };
}

test("sessão completa coordena PROBE, ensino, exercício e SQL multilinha", async () => {
  const { io, application, outcome } = await runLoop({
    lines: ["Quero aprender SQL", "SELECT escolhe colunas", "SELECT customer_id, name", "FROM customers", ".enviar", "sair"],
  });
  assert.equal(outcome.reason, "manual_exit");
  assert.deepEqual(application.calls.slice(0, 5), [
    ["start", "Quero aprender SQL"], ["probe", "SELECT escolhe colunas"], ["prepare", 1],
    ["sql", "SELECT customer_id, name\nFROM customers"], ["prepare", 2],
  ]);
  for (const label of ["PROBE", "PLANO", "TUTOR", "EXERCÍCIO", "RESULTADO SQL", "FEEDBACK DO TUTOR", "PROGRESSO"]) {
    assert.match(io.output, new RegExp(`\\[${label}`));
  }
  assert.equal(io.closed, true);
});

for (const action of ["retry", "reteach", "practice", "advance", "review"]) {
  test(`ação ${action} retorna ao ciclo sem regra pedagógica no terminal`, async () => {
    const application = new ScriptedApplication({ action });
    const { io, outcome } = await runLoop({
      application,
      lines: ["SQL", "resposta", "SELECT customer_id FROM customers", ".enviar", "sair"],
    });
    assert.equal(outcome.reason, "manual_exit");
    assert.match(io.output, new RegExp(`\\[PRÓXIMA AÇÃO\\] ${action}`));
    if (action === "review") assert.match(io.output, /\[REVISÃO\]/);
  });
}

test("submissão incorreta mantém feedback e estado entre interações", async () => {
  const application = new ScriptedApplication({ validationStatus: "incorrect_result" });
  const { io, outcome } = await runLoop({
    application, lines: ["SQL", "resposta", "SELECT 1", ".enviar", "sair"],
  });
  assert.equal(outcome.reason, "manual_exit");
  assert.match(io.output, /status=incorrect_result/);
  assert.match(io.output, /Revise sua consulta/);
  assert.equal(application.calls.filter(([name]) => name === "sql").length, 1);
});

test("erro de sintaxe é exibido sem derrubar o processo", async () => {
  const application = new ScriptedApplication({ action: "retry", validationStatus: "execution_error" });
  const { io, outcome } = await runLoop({
    application, lines: ["SQL", "resposta", "SELEC", ".enviar", "sair"],
  });
  assert.equal(outcome.reason, "manual_exit");
  assert.match(io.output, /syntax_error/);
  assert.doesNotMatch(io.output, /stack/iu);
});

test("falha da LLM encerra de forma controlada", async () => {
  const { io, outcome } = await runLoop({
    application: new ScriptedApplication({ failAt: "llm" }), lines: ["SQL", "resposta"],
  });
  assert.equal(outcome.reason, "application_error");
  assert.match(io.output, /Conteúdo indisponível/);
});

test("falha inesperada do banco é sanitizada", async () => {
  const { io, outcome } = await runLoop({
    application: new ScriptedApplication({ failAt: "database" }),
    lines: ["SQL", "resposta", "SELECT 1", ".enviar"],
  });
  assert.equal(outcome.reason, "application_error");
  assert.doesNotMatch(io.output, /internal|secret|stack/iu);
  assert.match(io.output, /falha interna sanitizada/iu);
});

test("saída manual antes da sessão e EOF são limpos", async (t) => {
  await t.test("saída manual", async () => {
    const { outcome, application } = await runLoop({ lines: ["sair"] });
    assert.equal(outcome.reason, "manual_exit");
    assert.equal(application.calls.some(([name]) => name === "start"), false);
  });
  await t.test("EOF", async () => {
    const { outcome, application } = await runLoop({ lines: [] });
    assert.equal(outcome.reason, "eof");
    assert.equal(application.calls.at(-1)[0], "close");
  });
});

test("output nunca exibe segredo, metadata trusted ou reference query", async () => {
  const { io } = await runLoop({
    lines: ["SQL", "resposta", "SELECT 1", ".enviar", "sair"],
  });
  assert.doesNotMatch(io.output, /reference_query|validation_metadata|postgres:\/\/|api[_-]?key|stack trace/iu);
});
