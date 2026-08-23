import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTIVE_ACTIONS,
  ADAPTIVE_POLICY_VERSION,
  MAX_CONSECUTIVE_RETRIES,
  AdaptiveDecisionService,
  createAdaptiveDecision,
  decideNextAction,
} from "../../src/adaptive-decision/index.js";
import { createEvaluation, createLearnerState } from "../../src/domain/index.js";
import { KnowledgeGraph } from "../../src/knowledge-graph/index.js";
import { LearnerModelService } from "../../src/learner-model/index.js";

const TIMESTAMP = "2026-08-23T15:00:00.000Z";

function node(id, prerequisites = []) {
  return {
    id,
    label: id.toUpperCase(),
    description: `Conceito ${id}.`,
    prerequisites,
  };
}

function graph() {
  return new KnowledgeGraph({
    version: "adaptive-test-graph-v1",
    nodes: [
      node("select"),
      node("where", ["select"]),
      node("order_by", ["select"]),
      node("null", ["select"]),
      node("join", ["select", "null"]),
    ],
  });
}

function misconception(status = "confirmed") {
  return {
    id: `misconception-select-${status}`,
    concept: "select",
    description: "Confunde projeção de colunas com filtragem de linhas.",
    status,
    evidence_ids: [],
    observed_at: TIMESTAMP,
  };
}

function concept(conceptName, mastery, confidence = "medium", misconceptions = []) {
  return {
    id: `concept-state-${conceptName}`,
    concept: conceptName,
    mastery,
    confidence,
    misconceptions,
    evidence_ids: [],
    evidence_summary: {
      positive_attempts: 0,
      negative_attempts: 0,
      consecutive_positive: 0,
      consecutive_negative: 0,
    },
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function state(concepts) {
  return createLearnerState({
    id: "learner-state-adaptive",
    session_id: "session-adaptive",
    learning_goal: "SQL",
    concepts,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  });
}

function evaluation({
  correct = true,
  executionError = null,
  conceptualErrors = [],
  misconceptions = [],
  masteryEvidence = [],
  suggestedAction = "advance",
} = {}) {
  return createEvaluation({
    id: "evaluation-adaptive",
    attempt_id: "attempt-adaptive",
    exercise_id: "exercise-adaptive",
    assessment: {
      correct,
      execution_error: executionError,
      conceptual_errors: conceptualErrors,
      misconceptions,
      positive_evidence: [],
      negative_evidence: [],
      prerequisites_to_revisit: [],
    },
    feedback: {
      message_to_learner: "Avaliação concluída.",
      hints: [],
    },
    mastery_evidence: masteryEvidence,
    next_action: suggestedAction,
    evaluated_at: TIMESTAMP,
  });
}

function decide({
  learnerState,
  assessment = evaluation(),
  currentConcept = "select",
  retryCount,
  knowledgeGraph = graph(),
}) {
  const input = {
    learner_state: learnerState,
    evaluation: assessment,
    knowledge_graph: knowledgeGraph,
    current_concept: currentConcept,
  };
  if (retryCount !== undefined) {
    input.retry_count = retryCount;
  }
  return decideNextAction(input);
}

test("contrato limita ações e identifica a versão da política", () => {
  const result = decide({ learnerState: state([concept("select", 0.4, "low")]) });

  assert.deepEqual(ADAPTIVE_ACTIONS, ["retry", "reteach", "practice", "advance", "review"]);
  assert.equal(result.policy_version, ADAPTIVE_POLICY_VERSION);
  assert.equal(result.policy_version, "adaptive-policy-v1");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reason_codes));
});

test("mastery abaixo de 0.50 produz reteach", () => {
  const result = decide({ learnerState: state([concept("select", 0.49, "medium")]) });

  assert.equal(result.action, "reteach");
  assert.deepEqual(result.reason_codes, ["mastery_insufficient"]);
  assert.equal(result.next_concept, null);
});

test("mastery entre 0.50 e 0.79 produz practice", () => {
  const result = decide({ learnerState: state([concept("select", 0.79, "high")]) });

  assert.equal(result.action, "practice");
  assert.deepEqual(result.reason_codes, ["mastery_partial"]);
});

test("mastery operacional e confidence adequada permitem advance", () => {
  const learnerState = state([concept("select", 0.8, "medium")]);
  const result = decide({ learnerState });

  assert.equal(result.action, "advance");
  assert.equal(result.next_concept, "where");
  assert.deepEqual(result.reason_codes, [
    "operational_mastery",
    "prerequisites_satisfied",
    "blocked_prerequisites",
  ]);
  assert.deepEqual(graph().getPrerequisiteGaps(result.next_concept, learnerState), []);
});

test("mastery operacional com confidence low produz practice", () => {
  const result = decide({ learnerState: state([concept("select", 0.9, "low")]) });

  assert.equal(result.action, "practice");
  assert.deepEqual(result.reason_codes, ["confidence_insufficient"]);
});

test("misconception confirmada produz reteach", () => {
  const result = decide({
    learnerState: state([concept("select", 0.7, "medium", [misconception("confirmed")])]),
  });

  assert.equal(result.action, "reteach");
  assert.deepEqual(result.reason_codes, ["confirmed_misconception"]);
});

test("misconception suspeita com domínio parcial produz practice", () => {
  const result = decide({
    learnerState: state([concept("select", 0.7, "medium", [misconception("suspected")])]),
  });

  assert.equal(result.action, "practice");
  assert.deepEqual(result.reason_codes, ["suspected_misconception"]);
});

test("misconception suspeita com domínio insuficiente produz reteach", () => {
  const result = decide({
    learnerState: state([concept("select", 0.49, "low", [misconception("suspected")])]),
  });

  assert.equal(result.action, "reteach");
  assert.deepEqual(result.reason_codes, ["suspected_misconception", "mastery_insufficient"]);
});

for (const category of ["syntax_error", "execution_error"]) {
  test(`${category} isolado preserva nível pedagógico e produz retry`, () => {
    const learnerState = state([concept("select", 0.85, "high")]);
    const result = decide({
      learnerState,
      assessment: evaluation({
        correct: false,
        executionError: {
          category,
          sqlstate: category === "syntax_error" ? "42601" : "22012",
          message: "A consulta não pôde ser executada.",
        },
      }),
    });

    assert.equal(result.action, "retry");
    assert.deepEqual(result.reason_codes, ["isolated_execution_error"]);
    assert.equal(learnerState.concepts[0].mastery, 0.85);
  });
}

test("limite explícito impede loop infinito de retry", () => {
  const result = decide({
    learnerState: state([concept("select", 0.85, "high")]),
    retryCount: MAX_CONSECUTIVE_RETRIES,
    assessment: evaluation({
      correct: false,
      executionError: {
        category: "syntax_error",
        sqlstate: "42601",
        message: "A consulta não pôde ser executada.",
      },
    }),
  });

  assert.equal(result.action, "practice");
  assert.deepEqual(result.reason_codes, ["retry_limit_reached"]);
});

test("erro conceitual nunca é tratado como simples retry", () => {
  const result = decide({
    learnerState: state([concept("select", 0.7, "medium")]),
    assessment: evaluation({
      correct: false,
      conceptualErrors: [{
        code: "projection_vs_filter",
        concept: "select",
        description: "Usou projeção como se removesse linhas.",
      }],
      suggestedAction: "retry",
    }),
  });

  assert.equal(result.action, "practice");
  assert.deepEqual(result.reason_codes, ["conceptual_error", "mastery_partial"]);
});

test("conceito bloqueado não é escolhido e seu prerequisite disponível vem primeiro", () => {
  const learnerState = state([
    concept("select", 0.9, "high"),
    concept("where", 0.9, "high"),
    concept("order_by", 0.9, "high"),
    concept("null", 0.79, "high"),
  ]);
  const result = decide({ learnerState });

  assert.equal(result.action, "advance");
  assert.equal(result.next_concept, "null");
  assert.notEqual(result.next_concept, "join");
  assert.deepEqual(result.blocking_prerequisites, [{
    target_concept: "join",
    concept: "null",
    reason: "mastery_below_threshold",
    mastery: 0.79,
    confidence: "high",
  }]);
  assert.ok(result.reason_codes.includes("blocked_prerequisites"));
});

test("múltiplos conceitos disponíveis usam prioridade direta e ordem do grafo", () => {
  const learnerState = state([concept("select", 0.9, "high")]);

  assert.deepEqual(
    graph().getAvailableConcepts(learnerState).map((item) => item.id),
    ["where", "order_by", "null"],
  );
  assert.equal(decide({ learnerState }).next_concept, "where");
});

test("nenhuma opção de avanço produz review", () => {
  const learnerState = state([
    concept("select", 0.9, "high"),
    concept("where", 0.9, "high"),
    concept("order_by", 0.9, "high"),
    concept("null", 0.9, "high"),
    concept("join", 0.9, "high"),
  ]);
  const result = decide({ learnerState });

  assert.equal(result.action, "review");
  assert.equal(result.next_concept, null);
  assert.deepEqual(result.reason_codes, ["operational_mastery", "no_available_concept"]);
});

test("threshold 0.50 pertence a practice", () => {
  assert.equal(
    decide({ learnerState: state([concept("select", 0.5, "medium")]) }).action,
    "practice",
  );
});

test("threshold 0.80 com confidence medium pertence a advance", () => {
  assert.equal(
    decide({ learnerState: state([concept("select", 0.8, "medium")]) }).action,
    "advance",
  );
});

test("consome o LearnerState já atualizado pelo Learner Model Service", () => {
  const original = state([concept("select", 0.75, "medium")]);
  const assessment = evaluation({
    masteryEvidence: [{
      id: "mastery-evidence-adaptive",
      attempt_id: "attempt-adaptive",
      concept: "select",
      direction: "up",
      strength: "strong",
      reason: "Resultado correto com evidência forte.",
      observed_at: TIMESTAMP,
    }],
  });
  const updated = new LearnerModelService().update(original, assessment).learner_state;

  assert.equal(original.concepts[0].mastery, 0.75);
  assert.equal(updated.concepts[0].mastery, 0.85);
  assert.equal(decide({ learnerState: updated, assessment }).action, "advance");
});

test("mesma entrada produz decisão determinística", () => {
  const input = {
    learnerState: state([concept("select", 0.8, "medium")]),
    assessment: evaluation(),
  };

  assert.deepEqual(decide(input), decide(input));
});

test("decisão não modifica LearnerState, Evaluation ou KnowledgeGraph", () => {
  const learnerState = state([concept("select", 0.8, "medium")]);
  const assessment = evaluation();
  const knowledgeGraph = graph();
  const before = {
    state: JSON.stringify(learnerState),
    evaluation: JSON.stringify(assessment),
    graph: JSON.stringify(knowledgeGraph),
  };

  new AdaptiveDecisionService().decide({
    learner_state: learnerState,
    evaluation: assessment,
    knowledge_graph: knowledgeGraph,
    current_concept: "select",
  });

  assert.equal(JSON.stringify(learnerState), before.state);
  assert.equal(JSON.stringify(assessment), before.evaluation);
  assert.equal(JSON.stringify(knowledgeGraph), before.graph);
  assert.ok(Object.isFrozen(learnerState));
  assert.ok(Object.isFrozen(assessment));
  assert.ok(Object.isFrozen(knowledgeGraph));
});

test("contrato rejeita action fora da política", () => {
  assert.throws(
    () => createAdaptiveDecision({
      action: "teach",
      current_concept: "select",
      next_concept: null,
      reason_codes: ["mastery_insufficient"],
      rationale: "Inválida.",
      blocking_prerequisites: [],
      policy_version: ADAPTIVE_POLICY_VERSION,
    }),
    /AdaptiveDecision.action/u,
  );
});
