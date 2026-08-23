import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTIVE_POLICY_VERSION,
  AdaptiveDecisionService,
  createAdaptiveDecision,
} from "../../src/adaptive-decision/index.js";
import { createEvaluation, createLearnerState } from "../../src/domain/index.js";
import { KnowledgeGraph } from "../../src/knowledge-graph/index.js";
import {
  PROBE_POLICY_VERSION,
  createProbeSession,
} from "../../src/probe/index.js";
import {
  InvalidLearningFlowTransitionError,
  LEARNING_FLOW_EVENTS,
  LEARNING_FLOW_EVENT_VERSION,
  LEARNING_FLOW_PHASES,
  LEARNING_FLOW_POLICY_VERSION,
  LearningFlowGuardError,
  LearningStateMachine,
  UnknownLearningFlowEventError,
} from "../../src/state-machine/index.js";

const TIME = "2026-08-23T18:00:00.000Z";
const SESSION_ID = "learning-session-b14";

function machine() {
  return new LearningStateMachine({ clock: () => TIME });
}

function learnerState() {
  return createLearnerState({
    id: "learner-state-b14",
    session_id: SESSION_ID,
    learning_goal: "SQL",
    concepts: [{
      id: "concept-state-b14-select",
      concept: "select",
      mastery: 0.8,
      confidence: "medium",
      misconceptions: [],
      evidence_ids: [],
      evidence_summary: {},
      created_at: TIME,
      updated_at: TIME,
    }],
    created_at: TIME,
    updated_at: TIME,
  });
}

function completedProbe() {
  return createProbeSession({
    id: SESSION_ID,
    learning_goal: "SQL",
    primary_concepts: ["select"],
    target_concepts: ["select"],
    evaluated_concepts: ["select"],
    current_concept: null,
    current_difficulty: 3,
    question_count: 0,
    max_questions: 5,
    status: "completed",
    learner_state: learnerState(),
    history: [],
    completion_reason: "sufficient_evidence",
    result: {
      evaluated_concepts: ["select"],
      mastered_concepts: ["select"],
      partial_concepts: [],
      gaps: [],
      confidence: [{ concept: "select", confidence: "medium" }],
      misconceptions: [],
      next_concept_recommended: "select",
      completion_reason: "sufficient_evidence",
    },
    error: null,
    policy_version: PROBE_POLICY_VERSION,
    created_at: TIME,
    updated_at: TIME,
  });
}

function failedProbe({ category = "provider_error" } = {}) {
  return createProbeSession({
    id: SESSION_ID,
    learning_goal: "SQL",
    primary_concepts: ["select"],
    target_concepts: ["select"],
    evaluated_concepts: [],
    current_concept: null,
    current_difficulty: 3,
    question_count: 0,
    max_questions: 5,
    status: "error",
    learner_state: learnerState(),
    history: [],
    completion_reason: "llm_failure",
    result: null,
    error: {
      category,
      code: "probe_provider_failure",
      message: "Falha sanitizada.",
    },
    policy_version: PROBE_POLICY_VERSION,
    created_at: TIME,
    updated_at: TIME,
  });
}

function move(flowMachine, state, event, extra = {}) {
  return flowMachine.transition(state, event, {
    reason: `Teste do evento ${event}.`,
    timestamp: TIME,
    ...extra,
  });
}

function planState(flowMachine = machine()) {
  return flowMachine.applyProbeSession(
    flowMachine.create({ sessionId: SESSION_ID }),
    completedProbe(),
    { timestamp: TIME },
  );
}

function teachState(flowMachine = machine()) {
  return move(flowMachine, planState(flowMachine), "plan_ready");
}

function practiceState(flowMachine = machine()) {
  return move(flowMachine, teachState(flowMachine), "teaching_completed");
}

function evaluateState(flowMachine = machine()) {
  let state = practiceState(flowMachine);
  state = move(flowMachine, state, "exercise_ready", { exercise_id: "exercise-1" });
  return move(flowMachine, state, "answer_submitted", { exercise_id: "exercise-1" });
}

function adaptState(flowMachine = machine()) {
  return move(flowMachine, evaluateState(flowMachine), "evaluation_completed", {
    evaluation_id: "evaluation-1",
  });
}

const decisionReasons = {
  retry: ["isolated_execution_error"],
  reteach: ["mastery_insufficient"],
  practice: ["mastery_partial"],
  advance: ["operational_mastery", "prerequisites_satisfied"],
  review: ["operational_mastery", "no_available_concept"],
};

function adaptiveDecision(action) {
  return createAdaptiveDecision({
    action,
    current_concept: "select",
    next_concept: action === "advance" ? "where" : null,
    reason_codes: decisionReasons[action],
    rationale: `B10 decidiu ${action}.`,
    blocking_prerequisites: [],
    policy_version: ADAPTIVE_POLICY_VERSION,
  });
}

function applyReadiness() {
  return {
    kind: "apply",
    satisfied: true,
    evidence_ids: ["evidence-apply-ready"],
    policy_version: "apply-readiness-v1",
  };
}

function transferReadiness() {
  return {
    kind: "transfer_test",
    satisfied: true,
    evidence_ids: ["evidence-transfer-ready"],
    policy_version: "transfer-readiness-v1",
  };
}

function completionCriteria() {
  return {
    satisfied: true,
    apply_verified: true,
    transfer_verified: true,
    evidence_ids: ["evidence-learning-complete"],
    policy_version: "completion-policy-v1",
  };
}

function evaluatedApplyState(flowMachine = machine()) {
  let state = adaptState(flowMachine);
  state = move(flowMachine, state, "apply_ready", {
    readiness: applyReadiness(),
    exercise_id: "apply-1",
  });
  state = move(flowMachine, state, "apply_completed");
  state = move(flowMachine, state, "evaluation_completed", {
    evaluation_id: "evaluation-apply-1",
  });
  return state;
}

function transferEvaluationState(flowMachine = machine()) {
  let state = evaluatedApplyState(flowMachine);
  state = move(flowMachine, state, "transfer_test_ready", {
    readiness: transferReadiness(),
    exercise_id: "transfer-1",
  });
  return move(flowMachine, state, "transfer_test_completed");
}

test("cria LearningFlowState imutável em PROBE/active", () => {
  const state = machine().create({ sessionId: SESSION_ID });

  assert.equal(state.phase, "PROBE");
  assert.equal(state.status, "active");
  assert.equal(state.transition_sequence, 0);
  assert.deepEqual(state.transition_history, []);
  assert.equal(state.last_event, null);
  assert.equal(state.policy_version, LEARNING_FLOW_POLICY_VERSION);
  assert.ok(Object.isFrozen(state));
});

test("PROBE completed avança para PLAN usando contrato B13", () => {
  const state = planState();

  assert.equal(state.phase, "PLAN");
  assert.equal(state.current_concept, "select");
  assert.equal(state.last_event, "probe_completed");
  assert.equal(state.transition_history[0].source_policy_version, PROBE_POLICY_VERSION);
});

test("tentativa PROBE para PRACTICE é rejeitada", () => {
  const flowMachine = machine();
  const state = flowMachine.create({ sessionId: SESSION_ID });

  assert.throws(
    () => move(flowMachine, state, "practice_requested", {
      adaptive_decision: adaptiveDecision("practice"),
    }),
    InvalidLearningFlowTransitionError,
  );
});

test("PLAN avança para TEACH", () => {
  assert.equal(teachState().phase, "TEACH");
});

test("TEACH avança para PRACTICE", () => {
  assert.equal(practiceState().phase, "PRACTICE");
});

test("PRACTICE exige exercício e avança para EVALUATE após resposta", () => {
  const flowMachine = machine();
  const initial = practiceState(flowMachine);
  assert.throws(
    () => move(flowMachine, initial, "answer_submitted"),
    (error) => error instanceof LearningFlowGuardError && error.code === "missing_exercise",
  );

  const withExercise = move(flowMachine, initial, "exercise_ready", {
    exercise_id: "exercise-1",
  });
  const state = move(flowMachine, withExercise, "answer_submitted", {
    exercise_id: "exercise-1",
  });

  assert.equal(state.phase, "EVALUATE");
  assert.equal(state.current_exercise_id, "exercise-1");
});

test("EVALUATE avança para ADAPT somente com avaliação identificável", () => {
  const flowMachine = machine();
  const state = evaluateState(flowMachine);
  assert.throws(
    () => move(flowMachine, state, "evaluation_completed"),
    TypeError,
  );

  const adapted = move(flowMachine, state, "evaluation_completed", {
    evaluation_id: "evaluation-1",
  });
  assert.equal(adapted.phase, "ADAPT");
});

test("ADAPT + retry retorna a PRACTICE preservando exercício", () => {
  const flowMachine = machine();
  const state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("retry"),
    { timestamp: TIME },
  );

  assert.equal(state.phase, "PRACTICE");
  assert.equal(state.current_exercise_id, "exercise-1");
  assert.equal(state.last_event, "retry_requested");
});

test("ADAPT + reteach retorna a TEACH", () => {
  const flowMachine = machine();
  const state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("reteach"),
    { timestamp: TIME },
  );

  assert.equal(state.phase, "TEACH");
  assert.equal(state.current_concept, "select");
  assert.equal(state.current_exercise_id, null);
});

test("ADAPT + practice retorna a PRACTICE com novo ciclo", () => {
  const flowMachine = machine();
  const state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("practice"),
    { timestamp: TIME },
  );

  assert.equal(state.phase, "PRACTICE");
  assert.equal(state.current_exercise_id, null);
});

test("ADAPT + advance retorna a TEACH no próximo conceito", () => {
  const flowMachine = machine();
  const state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("advance"),
    { timestamp: TIME },
  );

  assert.equal(state.phase, "TEACH");
  assert.equal(state.current_concept, "where");
  assert.equal(state.current_exercise_id, null);
});

test("ADAPT + review entra em REVIEW", () => {
  const flowMachine = machine();
  const state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("review"),
    { timestamp: TIME },
  );

  assert.equal(state.phase, "REVIEW");
});

test("REVIEW retorna ao fluxo por PRACTICE", () => {
  const flowMachine = machine();
  let state = flowMachine.applyAdaptiveDecision(
    adaptState(flowMachine),
    adaptiveDecision("review"),
    { timestamp: TIME },
  );
  state = move(flowMachine, state, "review_completed");

  assert.equal(state.phase, "PRACTICE");
  assert.equal(state.current_exercise_id, null);
});

test("APPLY entra em EVALUATE e exige readiness estruturada", () => {
  const flowMachine = machine();
  const adaptive = adaptState(flowMachine);
  assert.throws(
    () => move(flowMachine, adaptive, "apply_ready", {
      readiness: { ...applyReadiness(), satisfied: false },
      exercise_id: "apply-1",
    }),
    (error) => error instanceof LearningFlowGuardError
      && error.code === "readiness_not_satisfied",
  );

  let state = move(flowMachine, adaptive, "apply_ready", {
    readiness: applyReadiness(),
    exercise_id: "apply-1",
  });
  assert.equal(state.phase, "APPLY");
  state = move(flowMachine, state, "apply_completed");
  assert.equal(state.phase, "EVALUATE");
});

test("TRANSFER_TEST exige APPLY avaliado e retorna a EVALUATE", () => {
  const flowMachine = machine();
  assert.throws(
    () => move(flowMachine, adaptState(flowMachine), "transfer_test_ready", {
      readiness: transferReadiness(),
      exercise_id: "transfer-1",
    }),
    (error) => error instanceof LearningFlowGuardError && error.code === "apply_not_verified",
  );

  let state = evaluatedApplyState(flowMachine);
  state = move(flowMachine, state, "transfer_test_ready", {
    readiness: transferReadiness(),
    exercise_id: "transfer-1",
  });
  assert.equal(state.phase, "TRANSFER_TEST");
  state = move(flowMachine, state, "transfer_test_completed");
  assert.equal(state.phase, "EVALUATE");
});

test("conclusão válida ocorre de EVALUATE após TRANSFER_TEST", () => {
  const flowMachine = machine();
  const state = move(flowMachine, transferEvaluationState(flowMachine), "learning_completed", {
    completion: completionCriteria(),
  });

  assert.equal(state.phase, "COMPLETED");
  assert.equal(state.status, "completed");
  assert.equal(state.current_exercise_id, null);
  assert.throws(
    () => move(flowMachine, state, "failure", {
      error: {
        code: "late_failure",
        message: "Não aplicável.",
        retryable: false,
        failed_event: null,
      },
    }),
    InvalidLearningFlowTransitionError,
  );
});

test("conclusão prematura é rejeitada", () => {
  const flowMachine = machine();
  const state = evaluateState(flowMachine);

  assert.throws(
    () => move(flowMachine, state, "learning_completed", {
      completion: completionCriteria(),
    }),
    (error) => error instanceof LearningFlowGuardError
      && error.code === "transfer_not_evaluated",
  );
});

test("evento desconhecido é rejeitado", () => {
  const flowMachine = machine();
  assert.throws(
    () => move(
      flowMachine,
      flowMachine.create({ sessionId: SESSION_ID }),
      "llm_forced_transition",
    ),
    UnknownLearningFlowEventError,
  );
});

test("transição conhecida fora da fase permitida é rejeitada", () => {
  const flowMachine = machine();
  assert.throws(
    () => move(
      flowMachine,
      flowMachine.create({ sessionId: SESSION_ID }),
      "teaching_completed",
    ),
    InvalidLearningFlowTransitionError,
  );
});

test("histórico registra sequência, estados, evento, razão e versões", () => {
  const state = teachState();

  assert.equal(state.transition_sequence, 2);
  assert.deepEqual(state.transition_history.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(state.transition_history.map((entry) => entry.event), [
    "probe_completed",
    "plan_ready",
  ]);
  for (const transition of state.transition_history) {
    assert.equal(transition.timestamp, TIME);
    assert.equal(transition.policy_version, LEARNING_FLOW_POLICY_VERSION);
    assert.equal(transition.event_version, LEARNING_FLOW_EVENT_VERSION);
    assert.ok(transition.reason.length > 0);
  }
  assert.deepEqual(state.transition_history.map(({ from, to }) => ({ from, to })), [
    { from: "PROBE", to: "PLAN" },
    { from: "PLAN", to: "TEACH" },
  ]);
});

test("transições preservam imutabilidade das entradas", () => {
  const flowMachine = machine();
  const state = adaptState(flowMachine);
  const decision = adaptiveDecision("practice");
  const stateBefore = JSON.stringify(state);
  const decisionBefore = JSON.stringify(decision);

  const next = flowMachine.applyAdaptiveDecision(state, decision, { timestamp: TIME });

  assert.equal(JSON.stringify(state), stateBefore);
  assert.equal(JSON.stringify(decision), decisionBefore);
  assert.notEqual(next, state);
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.transition_history));
  assert.ok(Object.isFrozen(next.transition_history.at(-1)));
});

test("estado desserializado com snapshot adulterado é rejeitado", () => {
  const flowMachine = machine();
  const state = JSON.parse(JSON.stringify(teachState(flowMachine)));
  state.current_concept = "where";

  assert.throws(
    () => move(flowMachine, state, "teaching_completed"),
    (error) => error.code === "invalid_history",
  );
});

test("mesma entrada e timestamp produzem o mesmo estado", () => {
  const leftMachine = machine();
  const rightMachine = machine();

  const left = teachState(leftMachine);
  const right = teachState(rightMachine);

  assert.deepEqual(left, right);
});

test("erro do PROBE fica explícito e não avança silenciosamente", () => {
  const flowMachine = machine();
  const initial = flowMachine.create({ sessionId: SESSION_ID });
  const failed = flowMachine.applyProbeSession(initial, failedProbe(), { timestamp: TIME });

  assert.equal(failed.phase, "PROBE");
  assert.equal(failed.status, "error");
  assert.equal(failed.last_event, "failure");
  assert.equal(failed.error.failed_event, "probe_completed");
  assert.throws(
    () => flowMachine.applyProbeSession(failed, completedProbe(), { timestamp: TIME }),
    InvalidLearningFlowTransitionError,
  );

  const serialized = JSON.parse(JSON.stringify(failed));
  const resumed = move(flowMachine, serialized, "resume_requested");
  assert.equal(resumed.phase, "PROBE");
  assert.equal(resumed.status, "active");
  assert.equal(resumed.error, null);
});

test("retry técnico não pode formar loop além do limite de B10", () => {
  const flowMachine = machine();
  let state = adaptState(flowMachine);

  for (let index = 0; index < 2; index += 1) {
    state = flowMachine.applyAdaptiveDecision(state, adaptiveDecision("retry"), {
      timestamp: TIME,
    });
    state = move(flowMachine, state, "answer_submitted", { exercise_id: "exercise-1" });
    state = move(flowMachine, state, "evaluation_completed", {
      evaluation_id: `evaluation-retry-${index + 1}`,
    });
  }

  assert.throws(
    () => flowMachine.applyAdaptiveDecision(state, adaptiveDecision("retry"), {
      timestamp: TIME,
    }),
    (error) => error instanceof LearningFlowGuardError && error.code === "retry_limit_reached",
  );
});

test("integra decisão real de B10 sem alterá-la", () => {
  const graph = new KnowledgeGraph({
    version: "state-machine-test-graph-v1",
    nodes: [
      { id: "select", label: "SELECT", description: "Seleção.", prerequisites: [] },
      { id: "where", label: "WHERE", description: "Filtro.", prerequisites: ["select"] },
    ],
  });
  const evaluation = createEvaluation({
    id: "evaluation-b10-b14",
    attempt_id: "attempt-b10-b14",
    exercise_id: "exercise-1",
    assessment: {
      correct: true,
      execution_error: null,
      conceptual_errors: [],
      misconceptions: [],
      positive_evidence: [],
      negative_evidence: [],
      prerequisites_to_revisit: [],
    },
    feedback: { message_to_learner: "Avaliação concluída.", hints: [] },
    mastery_evidence: [],
    next_action: "advance",
    evaluated_at: TIME,
  });
  const decision = new AdaptiveDecisionService().decide({
    learner_state: learnerState(),
    evaluation,
    knowledge_graph: graph,
    current_concept: "select",
    retry_count: 0,
  });
  const before = JSON.stringify(decision);
  const flowMachine = machine();

  const next = flowMachine.applyAdaptiveDecision(adaptState(flowMachine), decision, {
    timestamp: TIME,
  });

  assert.equal(decision.action, "advance");
  assert.equal(next.phase, "TEACH");
  assert.equal(next.current_concept, "where");
  assert.equal(next.transition_history.at(-1).source_policy_version, ADAPTIVE_POLICY_VERSION);
  assert.equal(JSON.stringify(decision), before);
});

test("fases e eventos públicos são estáveis e versionados", () => {
  assert.deepEqual(LEARNING_FLOW_PHASES, [
    "PROBE",
    "PLAN",
    "TEACH",
    "PRACTICE",
    "EVALUATE",
    "ADAPT",
    "REVIEW",
    "APPLY",
    "TRANSFER_TEST",
    "COMPLETED",
  ]);
  assert.ok(LEARNING_FLOW_EVENTS.includes("failure"));
  assert.ok(LEARNING_FLOW_EVENTS.includes("resume_requested"));
  assert.equal(LEARNING_FLOW_POLICY_VERSION, "learning-flow-policy-v1");
  assert.equal(LEARNING_FLOW_EVENT_VERSION, "learning-flow-events-v1");
});
