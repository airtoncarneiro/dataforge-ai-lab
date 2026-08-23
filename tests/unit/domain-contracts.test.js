import assert from "node:assert/strict";
import test from "node:test";

import {
  DOMAIN_SCHEMAS,
  DomainValidationError,
  NEXT_ACTIONS,
  createAssessment,
  createAttempt,
  createConceptState,
  createEvaluation,
  createEvaluationEvidence,
  createExecutionEvidence,
  createExercise,
  createLearnerState,
  createLearningSession,
  createMasteryChange,
  createMasteryEvidence,
  createMisconception,
} from "../../src/domain/index.js";

const CREATED_AT = "2026-08-23T12:00:00.000Z";
const UPDATED_AT = "2026-08-23T12:05:00.000Z";

function misconceptionInput(overrides = {}) {
  return {
    id: "misconception-left-join-filter",
    concept: "join_semantics",
    description: "Filtra a tabela da direita no WHERE e espera preservar linhas sem correspondência.",
    status: "confirmed",
    evidence_ids: ["evidence-negative-1"],
    observed_at: CREATED_AT,
    ...overrides,
  };
}

function conceptStateInput(overrides = {}) {
  return {
    id: "concept-state-join-semantics",
    concept: "join_semantics",
    mastery: 0.45,
    confidence: "medium",
    misconceptions: [misconceptionInput()],
    evidence_ids: ["evidence-negative-1"],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function exerciseInput(overrides = {}) {
  return {
    id: "exercise-left-join-1",
    concepts: ["join_semantics", "filtering"],
    difficulty: 3,
    objective: "Preservar clientes sem pedidos ao aplicar filtros.",
    statement: "Liste todos os clientes e os pedidos concluídos, mantendo clientes sem pedidos.",
    expected_skills: ["LEFT JOIN", "predicate placement"],
    validation_strategy: "RESULT_SET",
    evaluation_notes: ["Verificar preservação de linhas sem correspondência."],
    reference_solution: "SELECT ...",
    created_at: CREATED_AT,
    ...overrides,
  };
}

function positiveEvidenceInput(overrides = {}) {
  return {
    id: "evidence-positive-1",
    source: "validation",
    description: "O resultado contém todas as linhas esperadas.",
    details: [{ key: "same_rows", value: true }],
    observed_at: CREATED_AT,
    ...overrides,
  };
}

function masteryEvidenceInput(overrides = {}) {
  return {
    id: "mastery-evidence-1",
    attempt_id: "attempt-1",
    concept: "join_semantics",
    direction: "up",
    strength: "medium",
    reason: "Aplicou corretamente a semântica de LEFT JOIN.",
    observed_at: UPDATED_AT,
    ...overrides,
  };
}

function correctEvaluationInput(overrides = {}) {
  return {
    id: "evaluation-1",
    attempt_id: "attempt-1",
    exercise_id: "exercise-left-join-1",
    assessment: {
      correct: true,
      execution_error: null,
      conceptual_errors: [],
      misconceptions: [],
      positive_evidence: [positiveEvidenceInput()],
      negative_evidence: [],
      prerequisites_to_revisit: [],
    },
    feedback: {
      message_to_learner: "A consulta preservou corretamente os clientes sem pedidos.",
      hints: [],
    },
    mastery_evidence: [masteryEvidenceInput()],
    next_action: "advance",
    evaluated_at: UPDATED_AT,
    ...overrides,
  };
}

test("cria ConceptState e LearnerState válidos com misconception estruturada", () => {
  const concept = createConceptState(conceptStateInput());
  const learner = createLearnerState({
    id: "learner-state-1",
    session_id: "session-1",
    learning_goal: "SQL",
    concepts: [concept],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  });

  assert.equal(concept.mastery, 0.45);
  assert.equal(concept.confidence, "medium");
  assert.deepEqual(concept.misconceptions[0], misconceptionInput());
  assert.equal(learner.concepts[0].concept, "join_semantics");
  assert.ok(Object.isFrozen(learner));
  assert.ok(Object.isFrozen(learner.concepts));
});

test("cria LearningSession e Exercise válidos", () => {
  const session = createLearningSession({
    id: "session-1",
    learning_goal: "SQL",
    phase: "PRACTICE",
    learner_state_id: "learner-state-1",
    current_exercise_id: "exercise-left-join-1",
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  });
  const exercise = createExercise(exerciseInput());

  assert.equal(session.phase, "PRACTICE");
  assert.equal(exercise.objective, "Preservar clientes sem pedidos ao aplicar filtros.");
  assert.deepEqual(exercise.concepts, ["join_semantics", "filtering"]);
});

test("cria Attempt e ExecutionEvidence válidos e auditáveis", () => {
  const attempt = createAttempt({
    id: "attempt-1",
    session_id: "session-1",
    exercise_id: "exercise-left-join-1",
    submission: "SELECT customer_id FROM customers",
    execution_evidence_id: "execution-evidence-1",
    submitted_at: CREATED_AT,
  });
  const execution = createExecutionEvidence({
    id: "execution-evidence-1",
    attempt_id: "attempt-1",
    status: "ok",
    columns: ["customer_id"],
    rows: [{ customer_id: 1 }],
    row_count: 1,
    truncated: false,
    duration_ms: 2.4,
    error: null,
    explain: null,
    created_at: UPDATED_AT,
  });

  assert.equal(attempt.execution_evidence_id, execution.id);
  assert.equal(execution.attempt_id, attempt.id);
  assert.ok(Object.isFrozen(attempt));
});

test("cria Assessment, Evaluation e MasteryEvidence para resposta correta", () => {
  const evaluation = createEvaluation(correctEvaluationInput());

  assert.equal(evaluation.assessment.correct, true);
  assert.equal(evaluation.assessment.execution_error, null);
  assert.equal(evaluation.assessment.positive_evidence.length, 1);
  assert.equal(evaluation.mastery_evidence[0].direction, "up");
  assert.equal(evaluation.next_action, "advance");
});

test("cria Evaluation com erro de execução separado de erro conceitual", () => {
  const evaluation = createEvaluation({
    ...correctEvaluationInput(),
    assessment: {
      correct: false,
      execution_error: {
        category: "syntax_error",
        sqlstate: "42601",
        message: "A consulta possui sintaxe SQL inválida.",
      },
      conceptual_errors: [],
      misconceptions: [],
      positive_evidence: [],
      negative_evidence: [{
        id: "evidence-execution-1",
        source: "execution",
        description: "O PostgreSQL rejeitou a sintaxe.",
        observed_at: CREATED_AT,
      }],
      prerequisites_to_revisit: [],
    },
    feedback: {
      message_to_learner: "Revise a estrutura da cláusula SELECT.",
      hints: ["Confira a palavra-chave usada no início da consulta."],
    },
    mastery_evidence: [],
    next_action: "retry",
  });

  assert.equal(evaluation.assessment.correct, false);
  assert.equal(evaluation.assessment.execution_error.category, "syntax_error");
  assert.deepEqual(evaluation.assessment.conceptual_errors, []);
  assert.equal(evaluation.feedback.hints.length, 1);
});

test("cria MasteryChange sem calcular mastery", () => {
  const change = createMasteryChange({
    id: "mastery-change-1",
    concept_state_id: "concept-state-join-semantics",
    attempt_id: "attempt-1",
    previous_mastery: 0.45,
    new_mastery: 0.55,
    previous_confidence: "medium",
    new_confidence: "medium",
    mastery_evidence_ids: ["mastery-evidence-1"],
    policy_version: "not-applied-by-b07",
    changed_at: UPDATED_AT,
  });

  assert.equal(change.previous_mastery, 0.45);
  assert.equal(change.new_mastery, 0.55);
  assert.deepEqual(change.mastery_evidence_ids, ["mastery-evidence-1"]);
});

test("aceita os limites inclusivos de mastery 0 e 1", () => {
  assert.equal(createConceptState(conceptStateInput({ mastery: 0 })).mastery, 0);
  assert.equal(createConceptState(conceptStateInput({ mastery: 1 })).mastery, 1);
});

test("rejeita mastery abaixo de 0 ou acima de 1", () => {
  assert.throws(
    () => createConceptState(conceptStateInput({ mastery: -0.001 })),
    DomainValidationError,
  );
  assert.throws(
    () => createConceptState(conceptStateInput({ mastery: 1.001 })),
    DomainValidationError,
  );
});

test("rejeita confidence fora do enum", () => {
  assert.throws(
    () => createConceptState(conceptStateInput({ confidence: "very_high" })),
    /confidence/u,
  );
});

test("rejeita next_action fora do fluxo pedagógico", () => {
  assert.throws(
    () => createEvaluation(correctEvaluationInput({ next_action: "skip_everything" })),
    /next_action/u,
  );
});

test("rejeita Exercise sem conceito ou objetivo válido", async (context) => {
  await context.test("sem conceito", () => {
    assert.throws(() => createExercise(exerciseInput({ concepts: [] })), /concepts/u);
  });
  await context.test("sem objetivo", () => {
    assert.throws(() => createExercise(exerciseInput({ objective: " " })), /objective/u);
  });
});

test("misconceptions exigem informação estruturada e testável", () => {
  const misconception = createMisconception(misconceptionInput());

  assert.deepEqual(Object.keys(misconception), [
    "id",
    "concept",
    "description",
    "status",
    "evidence_ids",
    "observed_at",
  ]);
  assert.throws(() => createMisconception(true), /objeto/u);
  assert.throws(
    () => createMisconception(misconceptionInput({ description: "" })),
    /description/u,
  );
});

test("round-trip JSON preserva contratos normalizados", () => {
  const cases = [
    [createConceptState, conceptStateInput()],
    [createExercise, exerciseInput()],
    [createEvaluationEvidence, positiveEvidenceInput()],
    [createMasteryEvidence, masteryEvidenceInput()],
    [createEvaluation, correctEvaluationInput()],
  ];

  for (const [factory, input] of cases) {
    const first = factory(input);
    const fromJson = JSON.parse(JSON.stringify(first));
    assert.deepEqual(factory(fromJson), first);
  }
});

test("aplica defaults explícitos e determinísticos", () => {
  const concept = createConceptState({
    id: "concept-state-select",
    concept: "select",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  const session = createLearningSession({
    id: "session-2",
    learning_goal: "SQL",
    learner_state_id: "learner-state-2",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  const assessment = createAssessment({ correct: false });
  const execution = createExecutionEvidence({
    id: "execution-evidence-2",
    attempt_id: "attempt-2",
    status: "ok",
    created_at: CREATED_AT,
  });
  const exercise = createExercise((({ evaluation_notes, reference_solution, ...required }) => required)(
    exerciseInput(),
  ));

  assert.deepEqual(
    {
      mastery: concept.mastery,
      confidence: concept.confidence,
      misconceptions: concept.misconceptions,
      evidence_ids: concept.evidence_ids,
    },
    { mastery: 0, confidence: "low", misconceptions: [], evidence_ids: [] },
  );
  assert.equal(session.phase, "PROBE");
  assert.equal(session.current_exercise_id, null);
  assert.deepEqual(assessment, {
    correct: false,
    execution_error: null,
    conceptual_errors: [],
    misconceptions: [],
    positive_evidence: [],
    negative_evidence: [],
    prerequisites_to_revisit: [],
  });
  assert.deepEqual(execution.columns, []);
  assert.deepEqual(execution.rows, []);
  assert.equal(execution.duration_ms, 0);
  assert.equal(exercise.reference_solution, null);
  assert.deepEqual(exercise.evaluation_notes, []);
});

test("schemas publicados preservam enums e forma estrita para Structured Outputs", () => {
  const evaluationSchema = DOMAIN_SCHEMAS.Evaluation;

  assert.equal(evaluationSchema.additionalProperties, false);
  assert.deepEqual(evaluationSchema.properties.next_action.enum, NEXT_ACTIONS);
  assert.ok(evaluationSchema.required.includes("assessment"));
  assert.equal(
    evaluationSchema.properties.assessment.properties.correct.type,
    "boolean",
  );
  assert.equal(
    DOMAIN_SCHEMAS.ConceptState.properties.mastery.minimum,
    0,
  );
  assert.equal(
    DOMAIN_SCHEMAS.ConceptState.properties.mastery.maximum,
    1,
  );
});
