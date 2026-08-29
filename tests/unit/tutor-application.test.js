import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AdaptiveDecisionService } from "../../src/adaptive-decision/index.js";
import { EvaluatorService } from "../../src/evaluator/index.js";
import { ExerciseService } from "../../src/exercise/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../../src/knowledge-graph/index.js";
import { LearnerModelService } from "../../src/learner-model/index.js";
import { DemoLlmProvider, FakeLlmProvider, LlmAdapter } from "../../src/llm/index.js";
import { InMemoryLogger } from "../../src/logging/index.js";
import { TutorApplication, TutorPhaseService } from "../../src/orchestrator/index.js";
import { IdempotencyConflictError, InMemorySessionStore } from "../../src/persistence/index.js";
import { ProbeService } from "../../src/probe/index.js";
import {
  RESULT_VALIDATOR_POLICY_VERSION,
  createResultValidation,
} from "../../src/result-validator/index.js";
import { LearningStateMachine } from "../../src/state-machine/index.js";
import {
  TUTOR_POLICY_VERSION,
  createTutorPolicyContextBuilder,
} from "../../src/tutor-policy/index.js";

const START = Date.parse("2026-08-23T12:00:00.000Z");

function clock() {
  let tick = 0;
  return () => new Date(START + tick++).toISOString();
}

function correctValidation() {
  const rows = [
    { customer_id: 1, name: "Ana Souza" },
    { customer_id: 2, name: "Bruno Reis" },
    { customer_id: 3, name: "Carla Melo" },
    { customer_id: 4, name: "Diego Luz" },
  ];
  return createResultValidation({
    status: "correct",
    correct: true,
    execution: {
      status: "ok",
      columns: ["customer_id", "name"],
      rows,
      row_count: 4,
      truncated: false,
      duration_ms: 1.5,
      error: null,
    },
    expected_summary: {
      comparison_mode: "ORDERED_RESULT",
      expected_columns: ["customer_id", "name"],
      expected_row_count: 4,
      ordering_required: true,
      reference_executed: true,
    },
    actual_summary: {
      columns: ["customer_id", "name"],
      row_count: 4,
      truncated: false,
      result_digest: "sha256:demo-result",
    },
    mismatches: [],
    constraints: [],
    plan_evidence: null,
    validator_policy_version: RESULT_VALIDATOR_POLICY_VERSION,
  });
}

function technicalValidation(category = "syntax_error") {
  return createResultValidation({
    status: "execution_error",
    correct: false,
    execution: {
      status: "error",
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      duration_ms: 1.5,
      error: { category, sqlstate: "42601", message: "Erro técnico sanitizado." },
    },
    expected_summary: {
      comparison_mode: "ORDERED_RESULT",
      expected_columns: ["customer_id", "name"],
      expected_row_count: 4,
      ordering_required: true,
      reference_executed: true,
    },
    actual_summary: null,
    mismatches: [],
    constraints: [],
    plan_evidence: null,
    validator_policy_version: RESULT_VALIDATOR_POLICY_VERSION,
  });
}

async function applicationHarness({
  provider = new DemoLlmProvider(), sessionStore = null, logger, validation = correctValidation,
} = {}) {
  const now = clock();
  const adapter = new LlmAdapter({
    provider,
    policyVersion: TUTOR_POLICY_VERSION,
    timeoutMs: 100,
    maxRetries: 0,
    parameters: { temperature: 0 },
    logger,
  });
  const policyBuilder = await createTutorPolicyContextBuilder();
  const graph = SQL_KNOWLEDGE_GRAPH;
  const rawLearnerModel = new LearnerModelService();
  const rawEvaluator = new EvaluatorService({
    adapter, policyBuilder, knowledgeGraph: graph, clock: now,
  });
  const rawStateMachine = new LearningStateMachine({ clock: now });
  const calls = [];
  const learnerModel = {
    update(state, evaluation) {
      calls.push("B08");
      return rawLearnerModel.update(state, evaluation);
    },
  };
  const stateMachine = {
    create(input) { return rawStateMachine.create(input); },
    transition(state, event, input) { return rawStateMachine.transition(state, event, input); },
    applyProbeSession(state, probe, input) {
      return rawStateMachine.applyProbeSession(state, probe, input);
    },
    applyAdaptiveDecision(state, decision, input) {
      calls.push("B14");
      return rawStateMachine.applyAdaptiveDecision(state, decision, input);
    },
  };
  const resultValidator = {
    async validate() {
      calls.push("B16");
      return validation();
    },
  };
  const evaluator = {
    async evaluate(input) {
      calls.push("B17");
      return rawEvaluator.evaluate(input);
    },
  };
  const rawDecision = new AdaptiveDecisionService();
  const decisionService = {
    decide(input) {
      calls.push("B10");
      return rawDecision.decide(input);
    },
  };
  const app = new TutorApplication({
    probeService: new ProbeService({
      adapter,
      policyBuilder,
      knowledgeGraph: graph,
      learnerModel,
      clock: now,
    }),
    phaseService: new TutorPhaseService({ adapter, policyBuilder, knowledgeGraph: graph }),
    exerciseService: new ExerciseService({
      adapter,
      policyBuilder,
      knowledgeGraph: graph,
      clock: now,
    }),
    resultValidator,
    evaluator,
    learnerModel,
    decisionService,
    stateMachine,
    knowledgeGraph: graph,
    clock: now,
    probeTargetConcepts: ["select"],
    maxProbeQuestions: 5,
    targetDifficulty: "medium",
    sessionStore,
    logger,
  });
  return { app, calls, provider };
}

async function reachExercise(app) {
  let response = await app.start({ learningGoal: "Quero aprender SQL" });
  while (response.session.phase === "PROBE" && response.session.status === "active") {
    response = await app.submitProbeAnswer("SELECT projeta as colunas solicitadas.");
  }
  assert.equal(response.session.phase, "PLAN");
  return app.prepareLearningCycle();
}

test("coordena B13–B17 e serviços determinísticos na ordem authoritative", async () => {
  const { app, calls, provider } = await applicationHarness();
  const prepared = await reachExercise(app);
  assert.equal(prepared.session.phase, "PRACTICE");
  assert.equal(prepared.events.some((item) => item.type === "plan"), true);
  assert.equal(prepared.events.some((item) => item.type === "teach"), true);
  assert.equal(prepared.events.some((item) => item.type === "exercise"), true);
  assert.doesNotMatch(JSON.stringify(prepared), /reference_query|validation_metadata/iu);

  calls.length = 0;
  const evaluated = await app.submitSql(
    "SELECT customer_id, name FROM customers ORDER BY customer_id",
  );
  assert.deepEqual(calls, ["B16", "B17", "B08", "B10", "B14"]);
  assert.equal(evaluated.events.map((item) => item.type).join(","),
    "execution,feedback,progress,decision");
  assert.equal(evaluated.session.phase, "PRACTICE");
  assert.equal(evaluated.session.last_action, "practice");
  assert.equal(provider.callCount > 0, true);
  assert.equal(Object.isFrozen(app.session), true);
  assert.equal(Object.isFrozen(evaluated), true);
});

test("estado trusted permanece interno e não aparece no resultado da aplicação", async () => {
  const { app } = await applicationHarness();
  const prepared = await reachExercise(app);
  assert.equal(app.session.current_exercise.validation_metadata.reference_query.includes("SELECT"), true);
  assert.equal("current_exercise" in prepared.session, false);
  assert.doesNotMatch(
    JSON.stringify(prepared.events),
    /reference_query|reference_solution|validation_metadata|instructions|api[_-]?key/iu,
  );
});

test("B21 alterna pergunta socrática e pista sem expor ambas de uma vez", async () => {
  const { app } = await applicationHarness({ validation: () => technicalValidation() });
  await reachExercise(app);

  const first = await app.submitSql("SELEC customer_id FROM customers");
  assert.equal(first.session.last_action, "retry");
  assert.equal(first.session.retry_count, 1);
  assert.deepEqual(first.events.map((item) => item.type), [
    "execution", "feedback", "socratic_retry", "progress", "decision",
  ]);
  assert.equal(first.events.find((item) => item.type === "feedback").data.hints.length, 0);
  const question = first.events.find((item) => item.type === "socratic_retry").data;
  assert.equal(question.stage, "question");
  assert.match(question.message, /sintaxe/u);

  const second = await app.submitSql("SELEC customer_id FROM customers");
  assert.equal(second.session.last_action, "retry");
  assert.equal(second.session.retry_count, 2);
  const hint = second.events.find((item) => item.type === "socratic_retry").data;
  assert.equal(hint.stage, "hint");
  assert.doesNotMatch(JSON.stringify(second.events), /reference_query|reference_solution/iu);
});

test("modo demo produz respostas determinísticas e não chama rede", async () => {
  const request = {
    instructions: "demo",
    messages: [{
      role: "user",
      content: JSON.stringify({
        kind: "probe_question_directive",
        targets: ["select"],
        difficulty: 3,
        question_type: "conceptual",
      }),
    }],
    outputSchema: {},
    tools: [],
    parameters: {},
    policyVersion: TUTOR_POLICY_VERSION,
  };
  const first = await new DemoLlmProvider().generate(request);
  const second = await new DemoLlmProvider().generate(request);
  assert.deepEqual(first, second);
});

test("sessão completa funciona com FakeLlmProvider roteirizado", async () => {
  const demo = new DemoLlmProvider();
  const scenarios = [];
  const recorder = {
    name: "recording-demo",
    model: "deterministic-demo-v1",
    async generate(request) {
      const response = await demo.generate(request);
      scenarios.push({ type: "valid", output: response.output });
      return response;
    },
  };
  const recorded = await applicationHarness({ provider: recorder });
  await reachExercise(recorded.app);
  await recorded.app.submitSql("SELECT customer_id, name FROM customers ORDER BY customer_id");

  const fake = new FakeLlmProvider({ scenarios });
  const replayed = await applicationHarness({ provider: fake });
  await reachExercise(replayed.app);
  const evaluated = await replayed.app.submitSql(
    "SELECT customer_id, name FROM customers ORDER BY customer_id",
  );
  assert.equal(evaluated.session.attempt_count, 1);
  assert.equal(evaluated.events.find((item) => item.type === "feedback").data.correct, true);
  assert.equal(fake.callCount, scenarios.length);
});

test("B19 recupera sessão completa sem reaplicar Evaluation ou MasteryChange", async () => {
  const store = new InMemorySessionStore();
  const first = await applicationHarness({ sessionStore: store });
  await reachExercise(first.app);
  await first.app.submitSql("SELECT customer_id, name FROM customers ORDER BY customer_id");
  const before = first.app.session;
  await store.saveSessionSnapshot(before);

  const restarted = await applicationHarness({ sessionStore: store });
  const recovered = await restarted.app.resume(before.id);
  assert.equal(recovered.session.id, before.id);
  assert.equal(restarted.app.session.evaluations.length, 1);
  assert.equal(restarted.app.session.mastery_changes.length, before.mastery_changes.length);
  assert.equal(restarted.app.session.updated_at, before.updated_at);
  assert.equal(restarted.app.session.flow_state.policy_version, before.flow_state.policy_version);

  await store.saveEvaluation(before.id, before.evaluations[0]);
  await store.saveMasteryChanges(before.id, before.mastery_changes);
  assert.equal((await store.loadSessionSnapshot(before.id)).mastery_changes.length,
    before.mastery_changes.length);

  const conflictingAttempt = { ...before.attempts[0], submission: "SELECT 999" };
  await assert.rejects(
    store.saveAttempt(before.id, conflictingAttempt),
    IdempotencyConflictError,
  );
});

test("B20 registra ciclo correlacionado sem SQL ou metadata trusted", async () => {
  const logger = new InMemoryLogger();
  const { app } = await applicationHarness({ logger });
  await reachExercise(app);
  await app.submitSql("SELECT customer_id, name FROM customers ORDER BY customer_id");
  await app.endSession();

  const names = logger.events.map((event) => event.event_name);
  for (const name of [
    "session.started", "probe.started", "probe.completed", "flow.transitioned",
    "exercise.generated", "attempt.submitted", "sql.validated", "evaluation.completed",
    "learner_state.updated", "adaptive_decision.made", "session.ended",
  ]) assert.equal(names.includes(name), true, name);
  const evaluated = logger.events.find((event) => event.event_name === "evaluation.completed");
  assert.equal(typeof evaluated.correlation.session_id, "string");
  assert.equal(typeof evaluated.correlation.attempt_id, "string");
  assert.equal(typeof evaluated.correlation.evaluation_id, "string");
  assert.equal(typeof evaluated.correlation.llm_request_id, "string");
  assert.doesNotMatch(JSON.stringify(logger.events), /SELECT customer_id|reference_query|validation_metadata/iu);
});

test("B20 registra persistence/recovery e falha do logger não altera a sessão", async () => {
  const store = new InMemorySessionStore();
  const logger = new InMemoryLogger();
  const first = await applicationHarness({ sessionStore: store, logger });
  await first.app.start({ learningGoal: "Quero aprender SQL" });
  const sessionId = first.app.session.id;
  const recovered = await applicationHarness({ sessionStore: store, logger });
  await recovered.app.resume(sessionId);
  assert.equal(logger.events.some((event) => event.event_name === "persistence.saved"), true);
  assert.equal(logger.events.some((event) => event.event_name === "session.recovered"), true);

  const resilient = await applicationHarness({
    logger: { log() { throw new Error("sink indisponível"); } },
  });
  const started = await resilient.app.start({ learningGoal: "Quero aprender SQL" });
  assert.equal(started.session.status, "active");
});

test("coordenador não duplica cálculo de mastery nem importa acesso PostgreSQL direto", async () => {
  const source = await readFile(new URL("../../src/orchestrator/tutor-application.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mastery\s*[+\-*/]?=/u);
  assert.doesNotMatch(source, /\bpg\b|new Pool|\.query\s*\(/u);
  assert.match(source, /#learnerModel\.update/u);
  assert.match(source, /#resultValidator\.validate/u);
});
