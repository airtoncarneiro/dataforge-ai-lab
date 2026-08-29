import assert from "node:assert/strict";
import test from "node:test";

import { createSqlKnowledgeGraph } from "../../src/knowledge-graph/index.js";
import { LlmAdapter, FakeLlmProvider } from "../../src/llm/index.js";
import {
  ProbeService,
  PROBE_EVALUATION_OUTPUT_SCHEMA,
  PROBE_POLICY_VERSION,
  PROBE_QUESTION_OUTPUT_SCHEMA,
  ProbeValidationError,
} from "../../src/probe/index.js";
import {
  createTutorPolicyContextBuilder,
  TUTOR_POLICY_VERSION,
} from "../../src/tutor-policy/index.js";

const FIXED_TIME = "2026-08-23T15:00:00.000Z";

function question({
  concept,
  targets = [concept],
  difficulty = 3,
  questionType = "comparative",
  extra = {},
}) {
  return {
    type: "valid",
    output: {
      question: `Pergunta aberta sobre ${concept}?`,
      targets,
      difficulty,
      question_type: questionType,
      reason: `Discriminar conhecimento de ${concept}.`,
      ...extra,
    },
  };
}

function evaluation({
  concepts,
  correct = true,
  direction = "up",
  strength = "strong",
  conceptualErrors = [],
  misconceptions = [],
  prerequisites = [],
  extra = {},
}) {
  return {
    type: "valid",
    output: {
      assessment: {
        correct,
        conceptual_errors: conceptualErrors,
        misconceptions,
        prerequisites_to_revisit: prerequisites,
      },
      mastery_evidence: concepts.map((concept) => ({
        concept,
        direction,
        strength,
        reason: `${direction} ${strength} para ${concept}.`,
      })),
      rationale: "Avaliação diagnóstica estruturada, sem feedback ao aluno.",
      ...extra,
    },
  };
}

async function fixture(scenarios, { timeoutMs = 50, maxRetries = 0 } = {}) {
  const provider = new FakeLlmProvider({ scenarios });
  const adapter = new LlmAdapter({
    provider,
    policyVersion: TUTOR_POLICY_VERSION,
    timeoutMs,
    maxRetries,
    parameters: { temperature: 0 },
  });
  const policyBuilder = await createTutorPolicyContextBuilder();
  const service = new ProbeService({
    adapter,
    policyBuilder,
    knowledgeGraph: createSqlKnowledgeGraph(),
    clock: () => FIXED_TIME,
  });
  return { service, provider };
}

async function startJoinProbe(scenarios) {
  const context = await fixture(scenarios);
  const session = await context.service.start({
    learningGoal: "Quero aprender JOIN",
    targetConcepts: ["join"],
    maxQuestions: 8,
    sessionId: "probe-join",
  });
  return { ...context, session };
}

function selectQuestion({ difficulty, questionType }) {
  return question({ concept: "select", difficulty, questionType });
}

function selectFlowScenarios({ strength = "strong", maxQuestions = 8 } = {}) {
  const scenarios = [];
  const types = ["comparative", "conceptual", "explanatory", "comparative", "small_problem"];
  let difficulty = 3;
  for (let index = 0; index < 5; index += 1) {
    scenarios.push(selectQuestion({ difficulty, questionType: types[index] }));
    scenarios.push(evaluation({ concepts: ["select"], strength }));
    if (strength !== "weak") {
      difficulty = Math.min(5, difficulty + 1);
    }
  }
  return { scenarios, maxQuestions };
}

async function runFiveAnswers(service, maxQuestions) {
  let session = await service.start({
    learningGoal: "Quero aprender SELECT",
    targetConcepts: ["select"],
    maxQuestions,
    sessionId: `probe-select-${maxQuestions}`,
  });
  for (let index = 0; index < 5; index += 1) {
    session = await service.submitAnswer(session, { answer: `Resposta ${index + 1}` });
  }
  return session;
}

test("Quero aprender SQL inicia uma ProbeSession explícita antes de TEACH", async () => {
  const { service } = await fixture([
    question({ concept: "join", targets: ["join", "select"] }),
  ]);

  const session = await service.start({ learningGoal: "Quero aprender SQL" });

  assert.equal(session.status, "active");
  assert.equal(session.policy_version, PROBE_POLICY_VERSION);
  assert.equal(session.question_count, 1);
  assert.equal(session.current_concept, "join");
  assert.ok(session.target_concepts.includes("select"));
  assert.ok(session.target_concepts.includes("join"));
  assert.equal(session.history[0].question.intent, "discriminative");
  assert.equal(session.learner_state.concepts.length, session.target_concepts.length);
  assert.ok(session.learner_state.concepts.every((item) => (
    item.mastery === 0.5 && item.confidence === "low"
  )));
});

test("a primeira pergunta é aberta, discriminativa e usa schema estrito", async () => {
  const { session, provider } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
  ]);

  const current = session.history[0].question;
  assert.equal(current.question_type, "comparative");
  assert.equal(current.difficulty, 3);
  assert.deepEqual(current.targets, ["join", "select"]);
  assert.deepEqual(provider.calls[0].outputSchema, PROBE_QUESTION_OUTPUT_SCHEMA);
  assert.match(provider.calls[0].instructions, /não comece ensinando/iu);
});

test("resposta correta forte atualiza LearnerState via B08 e aumenta dificuldade", async () => {
  const { service, session } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({ concepts: ["join", "select"] }),
    question({
      concept: "null",
      targets: ["null", "select"],
      difficulty: 4,
      questionType: "conceptual",
    }),
  ]);

  const next = await service.submitAnswer(session, { answer: "JOIN combina relações por condição." });
  const join = next.learner_state.concepts.find((item) => item.concept === "join");

  assert.equal(join.mastery, 0.6);
  assert.equal(join.confidence, "low");
  assert.equal(next.current_difficulty, 4);
  assert.equal(next.current_concept, "null");
  assert.equal(next.history[0].mastery_changes[0].policy_version, "mastery-policy-v1");
});

test("resposta incorreta reduz dificuldade e investiga prerequisite", async () => {
  const { service, session } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({
      concepts: ["join"],
      correct: false,
      direction: "down",
      prerequisites: ["select"],
    }),
    question({
      concept: "select",
      difficulty: 2,
      questionType: "explanatory",
    }),
  ]);

  const next = await service.submitAnswer(session, { answer: "JOIN apenas ordena as linhas." });
  const join = next.learner_state.concepts.find((item) => item.concept === "join");

  assert.equal(join.mastery, 0.4);
  assert.equal(next.current_concept, "select");
  assert.equal(next.current_difficulty, 2);
  assert.equal(next.history[1].question.intent, "prerequisite_check");
});

test("normaliza sugestão de prerequisite fora do grafo sem encerrar o PROBE", async () => {
  const { service, session, provider } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({
      concepts: ["join"],
      correct: false,
      direction: "down",
      prerequisites: ["select", "aggregate_functions"],
    }),
    question({
      concept: "select",
      difficulty: 2,
      questionType: "explanatory",
    }),
  ]);

  const next = await service.submitAnswer(session, { answer: "JOIN ordena linhas." });

  assert.equal(next.status, "active");
  assert.deepEqual(next.history[0].evaluation.assessment.prerequisites_to_revisit, ["select"]);
  assert.equal(next.current_concept, "select");
  const directive = JSON.parse(provider.calls[1].messages.at(-1).content);
  assert.ok(directive.allowed_prerequisites_to_revisit.includes("select"));
  assert.ok(directive.allowed_prerequisites_to_revisit.includes("null"));
  assert.ok(!directive.allowed_prerequisites_to_revisit.includes("aggregate_functions"));
});

test("misconception detectada permanece estruturada e limita mastery", async () => {
  const misconception = {
    concept: "join",
    description: "Confunde JOIN com ordenação de linhas.",
    status: "confirmed",
    evidence: "A explicação atribui ao JOIN a função de ORDER BY.",
  };
  const { service, session } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({
      concepts: ["join"],
      correct: false,
      direction: "down",
      misconceptions: [misconception],
    }),
    question({
      concept: "select",
      difficulty: 2,
      questionType: "explanatory",
    }),
  ]);

  const next = await service.submitAnswer(session, { answer: "JOIN serve para ordenar." });
  const join = next.learner_state.concepts.find((item) => item.concept === "join");

  assert.equal(join.mastery, 0.36);
  assert.equal(join.misconceptions.length, 1);
  assert.equal(join.misconceptions[0].status, "confirmed");
  assert.match(join.misconceptions[0].description, /ordenação/u);
});

test("PROBE não oferece solução, dica ou feedback de ensino", async () => {
  const { service, session, provider } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({ concepts: ["join", "select"] }),
    question({
      concept: "null",
      targets: ["null", "select"],
      difficulty: 4,
      questionType: "conceptual",
    }),
  ]);

  const next = await service.submitAnswer(session, { answer: "Uma resposta diagnóstica." });
  const first = next.history[0];

  assert.deepEqual(Object.keys(first.question).sort(), [
    "concept",
    "created_at",
    "difficulty",
    "id",
    "intent",
    "question",
    "question_type",
    "reason",
    "targets",
  ]);
  assert.deepEqual(first.evaluation.feedback.hints, []);
  assert.match(first.evaluation.feedback.message_to_learner, /nenhuma solução/iu);
  assert.deepEqual(provider.calls[1].outputSchema, PROBE_EVALUATION_OUTPUT_SCHEMA);
  assert.doesNotMatch(JSON.stringify(provider.calls[1].outputSchema), /solution|hint|feedback/iu);
});

test("evidência objetiva opcional é reduzida e sanitizada antes da LLM", async () => {
  const { service, session, provider } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({
      concepts: ["join"],
      correct: false,
      direction: "down",
      prerequisites: ["select"],
    }),
    question({
      concept: "select",
      difficulty: 2,
      questionType: "explanatory",
    }),
  ]);

  const next = await service.submitAnswer(session, {
    answer: "SELECT inválido",
    executionEvidence: {
      status: "error",
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      duration_ms: 2,
      error: {
        category: "syntax_error",
        sqlstate: "42601",
        message: "password=do-not-leak internal stack",
      },
    },
  });

  const serializedCall = JSON.stringify(provider.calls[1]);
  assert.doesNotMatch(serializedCall, /do-not-leak|internal stack/iu);
  assert.equal(next.history[0].evaluation.assessment.execution_error.category, "syntax_error");
  assert.equal(
    next.history[0].evaluation.assessment.execution_error.message,
    "Erro de execução sanitizado pelo SQL Sandbox.",
  );
});

test("encerra antecipadamente após cinco perguntas com evidência suficiente", async () => {
  const { scenarios } = selectFlowScenarios({ strength: "strong" });
  const { service, provider } = await fixture(scenarios);

  const session = await runFiveAnswers(service, 8);

  assert.equal(session.status, "completed");
  assert.equal(session.completion_reason, "sufficient_evidence");
  assert.equal(session.question_count, 5);
  assert.deepEqual(session.result.mastered_concepts, ["select"]);
  assert.deepEqual(session.result.evaluated_concepts, ["select"]);
  assert.equal(session.result.confidence[0].confidence, "high");
  assert.equal(provider.callCount, 10);
});

test("encerra deterministically por max_questions", async () => {
  const { scenarios } = selectFlowScenarios({ strength: "weak", maxQuestions: 5 });
  const { service } = await fixture(scenarios);

  const session = await runFiveAnswers(service, 5);

  assert.equal(session.status, "completed");
  assert.equal(session.completion_reason, "max_questions");
  assert.equal(session.question_count, 5);
  assert.equal(session.learner_state.concepts[0].mastery, 0.6);
});

test("mastery final não pode ser definido pela LLM", async () => {
  const { service, session } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({ concepts: ["join"], extra: { new_mastery: 1 } }),
  ]);

  const failed = await service.submitAnswer(session, { answer: "Resposta." });

  assert.equal(failed.status, "error");
  assert.equal(failed.error.category, "schema_validation_error");
  assert.equal(failed.learner_state.concepts.find((item) => item.concept === "join").mastery, 0.5);
  assert.equal(failed.history[0].evaluation, null);
});

test("próximo conceito recomendado no resultado respeita disponibilidade no grafo", async () => {
  const { scenarios } = selectFlowScenarios({ strength: "weak", maxQuestions: 5 });
  const { service } = await fixture(scenarios);
  const session = await runFiveAnswers(service, 5);

  assert.equal(session.result.next_concept_recommended, "select");
  assert.ok(session.result.partial_concepts.includes("select"));
});

test("FakeLlmProvider produz o mesmo diagnóstico para a mesma entrada", async () => {
  const scenarios = [question({ concept: "select" })];
  const left = await fixture(scenarios);
  const right = await fixture(scenarios);

  const [leftSession, rightSession] = await Promise.all([
    left.service.start({
      learningGoal: "SELECT",
      targetConcepts: ["select"],
      sessionId: "same-session",
    }),
    right.service.start({
      learningGoal: "SELECT",
      targetConcepts: ["select"],
      sessionId: "same-session",
    }),
  ]);

  assert.deepEqual(leftSession, rightSession);
  assert.deepEqual(left.provider.calls, right.provider.calls);
});

test("saída LLM incompatível com schema encerra sem vazar detalhes", async () => {
  const { service } = await fixture([
    question({ concept: "select", extra: { solution: "SELECT * FROM ..." } }),
  ]);

  const session = await service.start({
    learningGoal: "SELECT",
    targetConcepts: ["select"],
  });

  assert.equal(session.status, "error");
  assert.equal(session.completion_reason, "llm_failure");
  assert.equal(session.error.category, "schema_validation_error");
  assert.doesNotMatch(JSON.stringify(session), /SELECT \* FROM|stack|api[_-]?key/iu);
});

test("timeout da LLM é retornado como falha sanitizada", async () => {
  const { service } = await fixture([{ type: "timeout" }], { timeoutMs: 5 });

  const session = await service.start({
    learningGoal: "SELECT",
    targetConcepts: ["select"],
  });

  assert.equal(session.status, "error");
  assert.equal(session.error.category, "timeout");
  assert.equal(session.error.code, "request_timeout");
});

test("provider error é retornado sem payload interno", async () => {
  const { service } = await fixture([{ type: "provider_error" }]);

  const session = await service.start({
    learningGoal: "SELECT",
    targetConcepts: ["select"],
  });

  assert.equal(session.status, "error");
  assert.equal(session.error.category, "provider_error");
  assert.equal(session.error.code, "fake_provider_error");
  assert.doesNotMatch(JSON.stringify(session.error), /stack|scenario|credentials/iu);
});

test("sessões e entradas permanecem imutáveis", async () => {
  const { service, session } = await startJoinProbe([
    question({ concept: "join", targets: ["join", "select"] }),
    evaluation({ concepts: ["join", "select"] }),
    question({
      concept: "null",
      targets: ["null", "select"],
      difficulty: 4,
      questionType: "conceptual",
    }),
  ]);
  const before = JSON.stringify(session);

  const next = await service.submitAnswer(session, { answer: "Resposta." });

  assert.equal(JSON.stringify(session), before);
  assert.notEqual(next, session);
  assert.ok(Object.isFrozen(session));
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.history));
  assert.throws(() => {
    session.status = "completed";
  }, TypeError);
});

test("limites de aproximadamente 5–12 questões são validados", async () => {
  const { service } = await fixture([question({ concept: "select" })]);

  await assert.rejects(
    service.start({ learningGoal: "SELECT", targetConcepts: ["select"], maxQuestions: 4 }),
    (error) => error instanceof ProbeValidationError && error.code === "invalid_max_questions",
  );
  await assert.rejects(
    service.start({ learningGoal: "SELECT", targetConcepts: ["select"], maxQuestions: 13 }),
    (error) => error instanceof ProbeValidationError && error.code === "invalid_max_questions",
  );
});
