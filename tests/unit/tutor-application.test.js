import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AdaptiveDecisionService } from "../../src/adaptive-decision/index.js";
import { EvaluatorService } from "../../src/evaluator/index.js";
import { ExerciseService } from "../../src/exercise/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../../src/knowledge-graph/index.js";
import { LearnerModelService } from "../../src/learner-model/index.js";
import { DemoLlmProvider, FakeLlmProvider, LlmAdapter } from "../../src/llm/index.js";
import { TutorApplication, TutorPhaseService } from "../../src/orchestrator/index.js";
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

async function applicationHarness({ provider = new DemoLlmProvider() } = {}) {
  const now = clock();
  const adapter = new LlmAdapter({
    provider,
    policyVersion: TUTOR_POLICY_VERSION,
    timeoutMs: 100,
    maxRetries: 0,
    parameters: { temperature: 0 },
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
      return correctValidation();
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

test("coordenador não duplica cálculo de mastery nem importa acesso PostgreSQL direto", async () => {
  const source = await readFile(new URL("../../src/orchestrator/tutor-application.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mastery\s*[+\-*/]?=/u);
  assert.doesNotMatch(source, /\bpg\b|new Pool|\.query\s*\(/u);
  assert.match(source, /#learnerModel\.update/u);
  assert.match(source, /#resultValidator\.validate/u);
});
