import assert from "node:assert/strict";
import test from "node:test";

import { createLearnerState } from "../../src/domain/index.js";
import {
  MASTERY_POLICY_VERSION,
  LearnerModelService,
  UnknownConceptError,
  classifyMastery,
} from "../../src/learner-model/index.js";

const BASE_TIME = "2026-08-23T12:00:00.000Z";

function atMinute(minute) {
  return new Date(Date.UTC(2026, 7, 23, 12, minute)).toISOString();
}

function conceptInput(concept, overrides = {}) {
  return {
    id: `concept-state-${concept}`,
    concept,
    mastery: 0.4,
    confidence: "low",
    misconceptions: [],
    evidence_ids: [],
    evidence_summary: {
      positive_attempts: 0,
      negative_attempts: 0,
      consecutive_positive: 0,
      consecutive_negative: 0,
    },
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    ...overrides,
  };
}

function learnerState(concepts) {
  return createLearnerState({
    id: "learner-state-1",
    session_id: "session-1",
    learning_goal: "SQL",
    concepts,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
  });
}

function masteryEvidence({ evaluationId, attemptId, concept, direction, strength, index = 0 }) {
  return {
    id: `mastery-evidence:${evaluationId}:${concept}:${index}`,
    attempt_id: attemptId,
    concept,
    direction,
    strength,
    reason: `${direction} ${strength} para ${concept}`,
    observed_at: evaluationId.time,
  };
}

function evaluationInput({
  sequence,
  time,
  evidence = [],
  conceptualErrors = [],
  misconceptions = [],
  correct = true,
}) {
  const id = `evaluation-${sequence}`;
  const attemptId = `attempt-${sequence}`;
  const evaluationId = { toString: () => id, time };
  const normalizedEvidence = evidence.map((item, index) => masteryEvidence({
    evaluationId,
    attemptId,
    index,
    ...item,
  }));
  const hasPositive = normalizedEvidence.some((item) => item.direction === "up")
    || misconceptions.some((item) => item.status === "resolved");
  const hasNegative = normalizedEvidence.some((item) => item.direction === "down")
    || conceptualErrors.length > 0
    || misconceptions.some((item) => item.status !== "resolved");

  return {
    id,
    attempt_id: attemptId,
    exercise_id: "exercise-1",
    assessment: {
      correct,
      execution_error: null,
      conceptual_errors: conceptualErrors,
      misconceptions,
      positive_evidence: hasPositive ? [{
        id: `evaluation-evidence:${id}:positive`,
        source: "validation",
        description: "Evidência positiva determinística.",
        observed_at: time,
      }] : [],
      negative_evidence: hasNegative ? [{
        id: `evaluation-evidence:${id}:negative`,
        source: "validation",
        description: "Evidência negativa determinística.",
        observed_at: time,
      }] : [],
      prerequisites_to_revisit: [],
    },
    feedback: {
      message_to_learner: correct ? "Tentativa avaliada." : "Revise o conceito.",
      hints: [],
    },
    mastery_evidence: normalizedEvidence,
    next_action: correct ? "practice" : "retry",
    evaluated_at: time,
  };
}

function misconception({
  concept = "join_semantics",
  status = "confirmed",
  evidenceId = "evaluation-evidence:evaluation-1:negative",
  observedAt = atMinute(1),
} = {}) {
  return {
    id: `misconception-${concept}`,
    concept,
    description: "Filtra a tabela da direita no WHERE e espera preservar linhas sem correspondência.",
    status,
    evidence_ids: [evidenceId],
    observed_at: observedAt,
  };
}

function conceptFrom(result, concept) {
  return result.learner_state.concepts.find((item) => item.concept === concept);
}

const service = new LearnerModelService();

test("aplica evidência positiva fraca sem grande oscilação", () => {
  const state = learnerState([conceptInput("select")]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "weak" }],
  });

  const result = service.update(state, evaluation);
  const updated = conceptFrom(result, "select");

  assert.equal(updated.mastery, 0.42);
  assert.equal(updated.confidence, "low");
  assert.equal(updated.evidence_summary.consecutive_positive, 1);
});

test("aplica evidência positiva forte sem elevar confidence para high isoladamente", () => {
  const state = learnerState([conceptInput("select", {
    mastery: 0.85,
    confidence: "medium",
  })]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "strong" }],
  });

  const updated = conceptFrom(service.update(state, evaluation), "select");

  assert.equal(updated.mastery, 0.95);
  assert.equal(updated.confidence, "medium");
  assert.equal(updated.evidence_summary.positive_attempts, 1);
});

test("múltiplas evidências positivas consecutivas elevam confidence low para medium", () => {
  let state = learnerState([conceptInput("select")]);

  for (const sequence of [1, 2]) {
    state = service.update(state, evaluationInput({
      sequence,
      time: atMinute(sequence),
      evidence: [{ concept: "select", direction: "up", strength: "weak" }],
    })).learner_state;
  }

  const updated = state.concepts[0];
  assert.equal(updated.mastery, 0.44);
  assert.equal(updated.confidence, "medium");
  assert.deepEqual(updated.evidence_summary, {
    positive_attempts: 2,
    negative_attempts: 0,
    consecutive_positive: 2,
    consecutive_negative: 0,
  });
});

test("confidence medium chega a high somente após evidência suficiente", () => {
  let state = learnerState([conceptInput("select", {
    mastery: 0.72,
    confidence: "medium",
    evidence_summary: {
      positive_attempts: 1,
      negative_attempts: 0,
      consecutive_positive: 1,
      consecutive_negative: 0,
    },
  })]);

  state = service.update(state, evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "medium" }],
  })).learner_state;
  assert.equal(state.concepts[0].confidence, "medium");

  state = service.update(state, evaluationInput({
    sequence: 2,
    time: atMinute(2),
    evidence: [{ concept: "select", direction: "up", strength: "medium" }],
  })).learner_state;
  assert.equal(state.concepts[0].confidence, "medium");

  state = service.update(state, evaluationInput({
    sequence: 3,
    time: atMinute(3),
    evidence: [{ concept: "select", direction: "up", strength: "medium" }],
  })).learner_state;
  assert.equal(state.concepts[0].mastery, 0.87);
  assert.equal(state.concepts[0].confidence, "high");
});

test("evidência negativa forte reduz mastery e confidence em somente um nível", () => {
  const state = learnerState([conceptInput("aggregation", {
    mastery: 0.82,
    confidence: "high",
  })]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "aggregation", direction: "down", strength: "strong" }],
    correct: false,
  });

  const updated = conceptFrom(service.update(state, evaluation), "aggregation");

  assert.equal(updated.mastery, 0.72);
  assert.equal(updated.confidence, "medium");
  assert.equal(updated.evidence_summary.consecutive_negative, 1);
});

test("registra misconception nova e aplica penalidade controlada", () => {
  const state = learnerState([conceptInput("join_semantics", {
    mastery: 0.7,
    confidence: "high",
  })]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    misconceptions: [misconception()],
    correct: false,
  });

  const result = service.update(state, evaluation);
  const updated = conceptFrom(result, "join_semantics");

  assert.equal(updated.mastery, 0.66);
  assert.equal(updated.confidence, "medium");
  assert.equal(updated.misconceptions[0].status, "confirmed");
  assert.match(result.mastery_changes[0].reason, /new:confirmed/u);
});

test("penaliza misconception persistente e acumula suas evidências", () => {
  const existing = misconception({
    evidenceId: "evaluation-evidence:previous:negative",
    observedAt: BASE_TIME,
  });
  const state = learnerState([conceptInput("join_semantics", {
    mastery: 0.66,
    confidence: "medium",
    misconceptions: [existing],
    evidence_ids: ["evaluation-evidence:previous:negative"],
  })]);
  const evaluation = evaluationInput({
    sequence: 2,
    time: atMinute(2),
    misconceptions: [misconception({
      evidenceId: "evaluation-evidence:evaluation-2:negative",
      observedAt: atMinute(2),
    })],
    correct: false,
  });

  const result = service.update(state, evaluation);
  const updated = conceptFrom(result, "join_semantics");

  assert.equal(updated.mastery, 0.6);
  assert.equal(updated.confidence, "low");
  assert.deepEqual(updated.misconceptions[0].evidence_ids, [
    "evaluation-evidence:previous:negative",
    "evaluation-evidence:evaluation-2:negative",
  ]);
  assert.match(result.mastery_changes[0].reason, /persistent:confirmed/u);
});

test("mantém misconception resolvida no histórico e remove sua limitação", () => {
  const existing = misconception({ observedAt: BASE_TIME });
  const state = learnerState([conceptInput("join_semantics", {
    mastery: 0.6,
    confidence: "medium",
    misconceptions: [existing],
  })]);
  const evaluation = evaluationInput({
    sequence: 3,
    time: atMinute(3),
    evidence: [{ concept: "join_semantics", direction: "up", strength: "strong" }],
    misconceptions: [misconception({
      status: "resolved",
      evidenceId: "evaluation-evidence:evaluation-3:positive",
      observedAt: atMinute(3),
    })],
  });

  const result = service.update(state, evaluation);
  const updated = conceptFrom(result, "join_semantics");

  assert.equal(updated.mastery, 0.7);
  assert.equal(updated.misconceptions[0].status, "resolved");
  assert.match(result.mastery_changes[0].reason, /resolved:resolved/u);
});

test("limita mastery no piso 0.0", () => {
  const state = learnerState([conceptInput("group_by", { mastery: 0.03 })]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "group_by", direction: "down", strength: "strong" }],
    conceptualErrors: [{
      code: "missing_grouping",
      concept: "group_by",
      description: "Não agrupou as colunas não agregadas.",
    }],
    correct: false,
  });

  assert.equal(conceptFrom(service.update(state, evaluation), "group_by").mastery, 0);
});

test("limita mastery no teto 1.0", () => {
  const state = learnerState([conceptInput("select", { mastery: 0.96 })]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "strong" }],
  });

  assert.equal(conceptFrom(service.update(state, evaluation), "select").mastery, 1);
});

test("rejeita conceito inexistente sem atualização parcial", () => {
  const state = learnerState([conceptInput("select")]);
  const snapshot = JSON.stringify(state);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "window_functions", direction: "up", strength: "medium" }],
  });

  assert.throws(
    () => service.update(state, evaluation),
    (error) => {
      assert.ok(error instanceof UnknownConceptError);
      assert.deepEqual(error.concepts, ["window_functions"]);
      return true;
    },
  );
  assert.equal(JSON.stringify(state), snapshot);
});

test("rejeita tentativa de fornecer novo mastery diretamente pela avaliação", () => {
  const state = learnerState([conceptInput("select")]);
  const evaluation = {
    ...evaluationInput({
      sequence: 1,
      time: atMinute(1),
      evidence: [{ concept: "select", direction: "up", strength: "weak" }],
    }),
    new_mastery: 1,
  };

  assert.throws(() => service.update(state, evaluation), /new_mastery.*campo desconhecido/u);
  assert.equal(state.concepts[0].mastery, 0.4);
});

test("atualiza múltiplos conceitos e preserva os não afetados", () => {
  const state = learnerState([
    conceptInput("select", { mastery: 0.4 }),
    conceptInput("filtering", { mastery: 0.6, confidence: "medium" }),
    conceptInput("joins", { mastery: 0.7, confidence: "medium" }),
  ]);
  const untouchedBefore = state.concepts[2];
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [
      { concept: "select", direction: "up", strength: "medium" },
      { concept: "filtering", direction: "down", strength: "weak" },
    ],
    correct: false,
  });

  const result = service.update(state, evaluation);

  assert.equal(conceptFrom(result, "select").mastery, 0.45);
  assert.equal(conceptFrom(result, "filtering").mastery, 0.58);
  assert.deepEqual(conceptFrom(result, "joins"), untouchedBefore);
  assert.equal(result.mastery_changes.length, 2);
});

test("produz resultado determinístico para a mesma entrada", () => {
  const state = learnerState([conceptInput("select")]);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "medium" }],
  });

  const first = service.update(state, evaluation);
  const second = service.update(state, evaluation);

  assert.deepEqual(second, first);
  assert.equal(
    first.mastery_changes[0].id,
    "mastery-change:evaluation-1:concept-state-select",
  );
});

test("preserva imutabilidade da entrada e congela toda saída", () => {
  const state = learnerState([conceptInput("select")]);
  const before = JSON.stringify(state);
  const evaluation = evaluationInput({
    sequence: 1,
    time: atMinute(1),
    evidence: [{ concept: "select", direction: "up", strength: "weak" }],
  });

  const result = service.update(state, evaluation);

  assert.equal(JSON.stringify(state), before);
  assert.notEqual(result.learner_state, state);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.learner_state));
  assert.ok(Object.isFrozen(result.learner_state.concepts[0]));
  assert.ok(Object.isFrozen(result.mastery_changes));
  assert.ok(Object.isFrozen(result.mastery_changes[0]));
});

test("MasteryChange registra tentativa, avaliação, evidências, versão e justificativa", () => {
  const state = learnerState([conceptInput("select")]);
  const evaluation = evaluationInput({
    sequence: 7,
    time: atMinute(7),
    evidence: [{ concept: "select", direction: "up", strength: "medium" }],
  });

  const change = service.update(state, evaluation).mastery_changes[0];

  assert.equal(change.attempt_id, "attempt-7");
  assert.equal(change.evaluation_id, "evaluation-7");
  assert.deepEqual(change.mastery_evidence_ids, [
    "mastery-evidence:evaluation-7:select:0",
  ]);
  assert.deepEqual(change.evaluation_evidence_ids, [
    "evaluation-evidence:evaluation-7:positive",
  ]);
  assert.equal(change.policy_version, MASTERY_POLICY_VERSION);
  assert.equal(change.changed_at, atMinute(7));
  assert.match(change.reason, /applied_delta=0\.050/u);
});

test("classifica mastery sem sobrescrever o score", () => {
  assert.equal(classifyMastery(0.49), "insufficient");
  assert.equal(classifyMastery(0.5), "partial");
  assert.equal(classifyMastery(0.79), "partial");
  assert.equal(classifyMastery(0.8), "operational");
});
