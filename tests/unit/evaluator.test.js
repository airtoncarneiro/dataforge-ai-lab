import assert from "node:assert/strict";
import test from "node:test";

import {
  createAttempt,
  createConceptState,
  createExercise,
  createLearnerState,
} from "../../src/domain/index.js";
import {
  EVALUATOR_POLICY_VERSION,
  EvaluatorService,
} from "../../src/evaluator/index.js";
import { toLearnerExercise } from "../../src/exercise/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../../src/knowledge-graph/index.js";
import { FakeLlmProvider, LlmAdapter } from "../../src/llm/index.js";
import {
  RESULT_VALIDATOR_POLICY_VERSION,
  createResultValidation,
} from "../../src/result-validator/index.js";
import {
  TutorPolicyContextBuilder,
  loadTutorPolicy,
} from "../../src/tutor-policy/index.js";

const NOW = "2026-08-23T12:00:00.000Z";
const policy = await loadTutorPolicy();
const policyBuilder = new TutorPolicyContextBuilder({ policy });

function learnerState() {
  return createLearnerState({
    id: "learner-state:evaluator",
    session_id: "session:evaluator",
    learning_goal: "SQL",
    concepts: SQL_KNOWLEDGE_GRAPH.getConcepts().map((node) => createConceptState({
      id: `concept-state:${node.id}`,
      concept: node.id,
      mastery: 0.6,
      confidence: "medium",
      misconceptions: [],
      evidence_ids: [],
      evidence_summary: {
        positive_attempts: 1,
        negative_attempts: 0,
        consecutive_positive: 1,
        consecutive_negative: 0,
      },
      created_at: NOW,
      updated_at: NOW,
    })),
    created_at: NOW,
    updated_at: NOW,
  });
}

function publicExercise({
  id = "exercise:evaluator",
  concepts = ["select"],
  expectedSkills = concepts,
  strategy = "RESULT_SET",
} = {}) {
  return toLearnerExercise(createExercise({
    id,
    concepts,
    difficulty: 3,
    objective: `Demonstrar ${concepts.join(", ")}.`,
    statement: "Na relação customers, retorne as informações solicitadas.",
    expected_skills: expectedSkills,
    validation_strategy: strategy,
    evaluation_notes: [],
    reference_solution: null,
    created_at: NOW,
  }));
}

function internalExercise({ referenceSolution = "SELECT secret_reference FROM internal" } = {}) {
  return createExercise({
    id: "exercise:evaluator",
    concepts: ["select"],
    difficulty: 3,
    objective: "Demonstrar SELECT.",
    statement: "Na relação customers, retorne as informações solicitadas.",
    expected_skills: ["select"],
    validation_strategy: "RESULT_SET",
    evaluation_notes: ["Nota interna sem solução."],
    reference_solution: referenceSolution,
    created_at: NOW,
  });
}

function attempt({
  id = "attempt:evaluator",
  exerciseId = "exercise:evaluator",
  submission = "SELECT customer_id FROM customers",
} = {}) {
  return createAttempt({
    id,
    session_id: "session:evaluator",
    exercise_id: exerciseId,
    submission,
    execution_evidence_id: "execution:evaluator",
    submitted_at: NOW,
  });
}

function okExecution() {
  return {
    status: "ok",
    columns: ["customer_id"],
    rows: [{ customer_id: 1 }],
    row_count: 1,
    truncated: false,
    duration_ms: 1.25,
    error: null,
  };
}

function failedExecution(category) {
  const sqlstates = {
    syntax_error: "42601",
    security_violation: "42501",
    timeout: "57014",
    execution_error: "22012",
  };
  return {
    status: "error",
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    duration_ms: 0.75,
    error: {
      category,
      sqlstate: sqlstates[category],
      message: "Mensagem sanitizada do Sandbox.",
    },
  };
}

function mismatchFor(status) {
  const values = {
    incorrect_result: ["incorrect_result", "execution.rows", "reference_result", "student_result"],
    wrong_columns: ["wrong_columns", "execution.columns", ["customer_id"], ["id"]],
    wrong_row_count: ["wrong_row_count", "execution.row_count", 2, 1],
    ordering_mismatch: ["ordering_mismatch", "execution.rows", "reference_order", "student_order"],
  };
  if (!values[status]) return [];
  const [code, field, expected, actual] = values[status];
  return [{ code, field, expected, actual }];
}

function validationFor({
  status = "correct",
  category = null,
  constraints = [],
  planEvidence = null,
} = {}) {
  let execution = okExecution();
  let mismatches = mismatchFor(status);
  if (["execution_error", "security_violation", "timeout"].includes(status)) {
    const resolvedCategory = category ?? (
      status === "execution_error" ? "execution_error" : status
    );
    execution = failedExecution(resolvedCategory);
    mismatches = [{
      code: "student_execution_error",
      field: "execution.status",
      expected: "ok",
      actual: resolvedCategory,
    }];
  }
  if (status === "reference_validation_error") {
    execution = null;
    mismatches = [{
      code: "reference_query_invalid",
      field: "trusted_validation_metadata",
      expected: "valid",
      actual: "invalid",
    }];
  }
  return createResultValidation({
    status,
    correct: status === "correct",
    execution,
    expected_summary: {
      comparison_mode: "RESULT_SET",
      expected_columns: ["customer_id"],
      expected_row_count: 1,
      ordering_required: status === "ordering_mismatch",
      reference_executed: true,
    },
    actual_summary: execution?.status === "ok" ? {
      columns: execution.columns,
      row_count: execution.row_count,
      truncated: execution.truncated,
      result_digest: "sha256:student-result",
    } : null,
    mismatches,
    constraints,
    plan_evidence: planEvidence,
    validator_policy_version: RESULT_VALIDATOR_POLICY_VERSION,
  });
}

function llmOutput({
  concept = "select",
  understanding = "partial",
  reasoningQuality = "adequate",
  conceptualErrors = [],
  misconceptions = [],
  positiveEvidence = [],
  negativeEvidence = [],
  prerequisites = [],
  direction = "up",
  strength = "medium",
  masteryEvidence = null,
  action = "practice",
  message = "Você chegou a uma evidência útil. Explique qual regra guiou sua escolha.",
  hints = ["Revise primeiro o objetivo e compare-o com a estrutura usada."],
  extra = {},
} = {}) {
  return {
    pedagogical_assessment: {
      understanding,
      reasoning_quality: reasoningQuality,
      conceptual_errors: conceptualErrors,
      misconceptions,
      positive_evidence: positiveEvidence,
      negative_evidence: negativeEvidence,
      prerequisites_to_revisit: prerequisites,
    },
    feedback: {
      message_to_learner: message,
      hints,
    },
    mastery_evidence: masteryEvidence ?? [{
      concept,
      direction,
      strength,
      reason: "A estrutura observada oferece evidência limitada sobre o conceito.",
    }],
    suggested_next_action: action,
    ...extra,
  };
}

function serviceFor(scenarios, { timeoutMs = 100 } = {}) {
  const provider = new FakeLlmProvider({ scenarios });
  const adapter = new LlmAdapter({
    provider,
    policyVersion: "tutor-policy-v0.1",
    timeoutMs,
    maxRetries: 0,
  });
  const service = new EvaluatorService({
    adapter,
    policyBuilder,
    knowledgeGraph: SQL_KNOWLEDGE_GRAPH,
    clock: () => NOW,
  });
  return { service, provider };
}

async function evaluate(service, overrides = {}) {
  return service.evaluate({
    exercise: publicExercise(),
    attempt: attempt(),
    validationResult: validationFor(),
    learnerState: learnerState(),
    evaluatedConcepts: ["select"],
    recentMessages: [],
    ...overrides,
  });
}

test("query objetiva correta produz Evaluation B07 e envelope auditável", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    understanding: "demonstrated",
    action: "advance",
  }) }]);

  const result = await evaluate(service);

  assert.equal(result.objective_assessment.correct, true);
  assert.equal(result.evaluation.assessment.correct, true);
  assert.equal(result.suggested_next_action, "advance");
  assert.equal(result.evaluator_policy_version, EVALUATOR_POLICY_VERSION);
  assert.equal(result.provenance.exercise_id, "exercise:evaluator");
  assert.equal(result.provenance.attempt_id, "attempt:evaluator");
  assert.equal(result.provenance.validator_policy_version, RESULT_VALIDATOR_POLICY_VERSION);
  assert.equal(result.provenance.tutor_policy_version, "tutor-policy-v0.1");
  assert.equal(result.provenance.llm_request_id, "fake-request-1");
});

test("correta aceita evidência weak, medium e strong somente conforme suporte objetivo", async () => {
  const scenarios = [
    { type: "valid", output: llmOutput({ strength: "weak" }) },
    { type: "valid", output: llmOutput({ strength: "medium" }) },
    { type: "valid", output: llmOutput({
      concept: "join",
      strength: "strong",
      action: "advance",
    }) },
  ];
  const { service } = serviceFor(scenarios);
  const weak = await evaluate(service, {
    attempt: attempt({ id: "attempt:weak" }),
  });
  const medium = await evaluate(service, {
    attempt: attempt({ id: "attempt:medium" }),
  });
  const joinExercise = publicExercise({
    id: "exercise:join",
    concepts: ["join"],
    expectedSkills: ["join", "select"],
  });
  const strong = await evaluate(service, {
    exercise: joinExercise,
    attempt: attempt({ id: "attempt:strong", exerciseId: "exercise:join" }),
    evaluatedConcepts: ["join"],
    validationResult: validationFor({ constraints: [{
      kind: "query_structure",
      target: "query.has_join",
      operator: "equals",
      expected: true,
      actual: true,
      passed: true,
    }] }),
  });

  assert.equal(weak.mastery_evidence[0].strength, "weak");
  assert.equal(medium.mastery_evidence[0].strength, "medium");
  assert.equal(strong.mastery_evidence[0].strength, "strong");
});

test("correct=true sem evidência estrutural limita sugestão strong a medium", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    strength: "strong",
    reasoningQuality: "superficial",
    understanding: "partial",
  }) }]);

  const result = await evaluate(service);

  assert.equal(result.mastery_evidence[0].strength, "medium");
  assert.equal(result.pedagogical_assessment.reasoning_quality, "superficial");
  assert.equal(result.objective_assessment.correct, true);
});

test("resultado incorreto preserva mismatch e gera evidência negativa", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    understanding: "insufficient",
    direction: "down",
    action: "practice",
  }) }]);

  const result = await evaluate(service, {
    validationResult: validationFor({ status: "incorrect_result" }),
  });

  assert.equal(result.objective_assessment.status, "incorrect_result");
  assert.equal(result.objective_assessment.mismatches[0].code, "incorrect_result");
  assert.equal(result.evaluation.assessment.correct, false);
  assert.ok(result.evidence.negative.some((item) => (
    item.details.some((detail) => detail.value === "incorrect_result")
  )));
});

test("coluna errada permanece wrong_columns", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "wrong_columns" }),
  });

  assert.equal(result.objective_assessment.status, "wrong_columns");
  assert.equal(result.objective_assessment.mismatches[0].field, "execution.columns");
});

test("ordering mismatch é preservado e feedback não o reclassifica", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
    message: "A ordenação solicitada ainda não foi demonstrada.",
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "ordering_mismatch" }),
  });

  assert.equal(result.objective_assessment.status, "ordering_mismatch");
  assert.equal(result.objective_assessment.mismatches[0].code, "ordering_mismatch");
  assert.equal(result.execution_error, null);
});

for (const fixture of [
  ["JOIN", "join", "query.has_join"],
  ["GROUP BY", "group_by", "query.has_group_by"],
  ["window function", "window_functions", "query.has_window_function"],
]) {
  const [label, concept, target] = fixture;
  test(`constraint ${label} gera erro conceitual grounded`, async () => {
    const { service } = serviceFor([{ type: "valid", output: llmOutput({
      concept,
      direction: "down",
      action: "reteach",
      understanding: "insufficient",
    }) }]);
    const exercise = publicExercise({
      id: `exercise:${concept}`,
      concepts: [concept],
      expectedSkills: [concept],
      strategy: "PROPERTY_BASED",
    });
    const result = await evaluate(service, {
      exercise,
      attempt: attempt({ id: `attempt:${concept}`, exerciseId: `exercise:${concept}` }),
      evaluatedConcepts: [concept],
      validationResult: validationFor({
        status: "constraint_violation",
        constraints: [{
          kind: "query_structure",
          target,
          operator: "equals",
          expected: true,
          actual: false,
          passed: false,
        }],
      }),
    });

    assert.equal(result.objective_assessment.status, "constraint_violation");
    assert.equal(result.conceptual_errors[0].concept, concept);
    assert.match(result.conceptual_errors[0].code, /^constraint_/u);
    assert.equal(result.suggested_next_action, "reteach");
  });
}

test("syntax error é execução, não erro conceitual inventado", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
    conceptualErrors: [{
      code: "invented_select_error",
      concept: "select",
      description: "Erro conceitual inventado.",
    }],
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "execution_error", category: "syntax_error" }),
  });

  assert.equal(result.execution_error.category, "syntax_error");
  assert.equal(result.execution_error.sqlstate, "42601");
  assert.deepEqual(result.conceptual_errors, []);
  assert.deepEqual(result.mastery_evidence, []);
  assert.equal(result.suggested_next_action, "retry");
});

for (const [status, category] of [
  ["timeout", "timeout"],
  ["security_violation", "security_violation"],
  ["execution_error", "execution_error"],
]) {
  test(`${status} permanece erro técnico authoritative`, async () => {
    const { service } = serviceFor([{ type: "valid", output: llmOutput({
      misconceptions: [{
        concept: "select",
        description: "Misconception sem evidência.",
        status: "confirmed",
        evidence: "A LLM tentou inferir a partir do erro técnico.",
      }],
      direction: "down",
      action: "reteach",
    }) }]);
    const result = await evaluate(service, {
      validationResult: validationFor({ status, category }),
    });

    assert.equal(result.execution_error.category, category);
    assert.deepEqual(result.misconceptions, []);
    assert.deepEqual(result.mastery_evidence, []);
    assert.equal(result.suggested_next_action, "retry");
  });
}

test("misconception sugerida fica estruturada e vinculada a evidence", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
    action: "reteach",
    misconceptions: [{
      concept: "select",
      description: "Confunde projeção com filtragem de linhas.",
      status: "suspected",
      evidence: "A tentativa omitiu a coluna explicitamente solicitada.",
    }],
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "wrong_columns" }),
  });

  assert.equal(result.misconceptions[0].concept, "select");
  assert.equal(result.misconceptions[0].status, "suspected");
  assert.equal(result.misconceptions[0].evidence_ids.length, 1);
  assert.ok(result.evidence.negative.some(
    (item) => item.id === result.misconceptions[0].evidence_ids[0],
  ));
});

test("erro conceitual sugerido é aceito somente em conceito avaliado", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
    conceptualErrors: [{
      code: "select_projection_confusion",
      concept: "select",
      description: "Não distinguiu projeção do conteúdo das linhas.",
    }],
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "incorrect_result" }),
  });

  assert.equal(result.conceptual_errors[0].code, "select_projection_confusion");
  assert.equal(result.conceptual_errors[0].concept, "select");
});

test("contradição semântica LLM versus B16 ativa fallback explícito", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    direction: "down",
    message: "A consulta está correta e pode avançar.",
    action: "advance",
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "incorrect_result" }),
  });

  assert.equal(result.objective_assessment.correct, false);
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.code, "objective_contradiction");
  assert.equal(result.suggested_next_action, "practice");
});

test("LLM tentando mudar correct é rejeitada pelo schema B11", async () => {
  const output = llmOutput({ extra: { correct: false } });
  const { service } = serviceFor([{ type: "valid", output }]);
  const result = await evaluate(service);

  assert.equal(result.objective_assessment.correct, true);
  assert.equal(result.evaluation.assessment.correct, true);
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.category, "schema_validation_error");
});

test("LLM tentando inventar execution result é rejeitada pelo schema B11", async () => {
  const output = llmOutput({
    extra: { execution_result: { status: "ok", rows: [{ invented: true }] } },
  });
  const { service } = serviceFor([{ type: "valid", output }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "timeout", category: "timeout" }),
  });

  assert.equal(result.execution_error.category, "timeout");
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.category, "schema_validation_error");
});

test("mastery evidence é validada, limitada e não contém score final", async () => {
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    strength: "strong",
  }) }]);
  const result = await evaluate(service);

  assert.deepEqual(Object.keys(result.mastery_evidence[0]), [
    "id",
    "attempt_id",
    "concept",
    "direction",
    "strength",
    "reason",
    "observed_at",
  ]);
  assert.equal(result.mastery_evidence[0].strength, "medium");
  assert.equal("mastery" in result.mastery_evidence[0], false);
});

test("suggested_next_action é apenas sugestão compatível com B10", async () => {
  const state = learnerState();
  const snapshot = structuredClone(state);
  const { service } = serviceFor([{ type: "valid", output: llmOutput({
    action: "advance",
  }) }]);
  const result = await evaluate(service, { learnerState: state });

  assert.equal(result.suggested_next_action, "advance");
  assert.equal(result.evaluation.next_action, "advance");
  assert.deepEqual(state, snapshot);
  assert.equal(result.provenance.evaluator_policy_version, EVALUATOR_POLICY_VERSION);
});

test("reference solution nunca entra no request nem no feedback", async () => {
  const secret = "SELECT secret_reference FROM internal";
  const { service, provider } = serviceFor([{ type: "valid", output: llmOutput() }]);
  const result = await evaluate(service, { exercise: internalExercise({
    referenceSolution: secret,
  }) });
  const serializedMessages = JSON.stringify(provider.calls[0].messages);

  assert.doesNotMatch(serializedMessages, /secret_reference|reference_solution/iu);
  assert.doesNotMatch(JSON.stringify(result), /secret_reference/iu);
});

test("feedback que revela solução SQL é rejeitado e substituído por fallback", async () => {
  const { service, provider } = serviceFor([{ type: "valid", output: llmOutput({
    message: "Use SELECT customer_id FROM customers como resposta.",
  }) }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "wrong_columns" }),
  });

  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.code, "solution_leak");
  assert.doesNotMatch(result.feedback, /SELECT customer_id FROM customers/iu);
  assert.equal(provider.callCount, 2);
});

test("feedback que vaza solução é regenerado uma vez e aceita somente saída segura", async () => {
  const { service, provider } = serviceFor([
    { type: "valid", output: llmOutput({ message: "Use SELECT email FROM customers como resposta." }) },
    { type: "valid", output: llmOutput({ message: "Quais colunas o enunciado realmente solicita?" }) },
  ]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "wrong_columns" }),
  });

  assert.equal(result.pedagogical_assessment.source, "llm");
  assert.equal(result.feedback, "Quais colunas o enunciado realmente solicita?");
  assert.equal(provider.callCount, 2);
  assert.match(provider.calls[1].messages.at(-1).content, /solution_leak/iu);
  assert.doesNotMatch(JSON.stringify(provider.calls[1].messages), /SELECT email FROM customers/iu);
});

test("timeout da LLM preserva fatos objetivos com fallback determinístico", async () => {
  const { service } = serviceFor([{ type: "timeout" }], { timeoutMs: 10 });
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "ordering_mismatch" }),
  });

  assert.equal(result.objective_assessment.status, "ordering_mismatch");
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.category, "timeout");
  assert.ok(result.evidence.negative.length > 0);
});

test("provider error preserva fatos objetivos com fallback determinístico", async () => {
  const { service } = serviceFor([{ type: "provider_error" }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ status: "incorrect_result" }),
  });

  assert.equal(result.objective_assessment.status, "incorrect_result");
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.category, "provider_error");
});

test("schema inválido é explícito e não apaga Evaluation objetiva", async () => {
  const { service } = serviceFor([{ type: "valid", output: {
    pedagogical_assessment: {},
  } }]);
  const result = await evaluate(service);

  assert.equal(result.objective_assessment.correct, true);
  assert.equal(result.pedagogical_assessment.source, "deterministic_fallback");
  assert.equal(result.pedagogical_assessment.llm_error.category, "schema_validation_error");
  assert.equal(result.mastery_evidence[0].strength, "weak");
});

test("FakeLlmProvider produz avaliação reproduzível para a mesma entrada", async () => {
  const scenario = [{ type: "valid", output: llmOutput() }];
  const first = await evaluate(serviceFor(scenario).service);
  const second = await evaluate(serviceFor(scenario).service);

  assert.deepEqual(first, second);
});

test("Evaluation e envelope são imutáveis e LearnerState não é atualizado", async () => {
  const state = learnerState();
  const snapshot = structuredClone(state);
  const { service } = serviceFor([{ type: "valid", output: llmOutput() }]);
  const result = await evaluate(service, { learnerState: state });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evaluation));
  assert.ok(Object.isFrozen(result.evaluation.assessment));
  assert.ok(Object.isFrozen(result.mastery_evidence));
  assert.deepEqual(state, snapshot);
  assert.equal(state.concepts[0].mastery, snapshot.concepts[0].mastery);
});

test("plano B16 é preservado sem interpretação operacional pela LLM", async () => {
  const planEvidence = {
    status: "ok",
    analyze: false,
    plan: {
      node_type: "Index Scan",
      relation_name: "orders",
      index_name: "idx_orders_customer_id",
      startup_cost: 0.1,
      total_cost: 2.3,
      plan_rows: 1,
      plan_width: 8,
      subplan_name: null,
      plans: [],
    },
    planning_time_ms: 0.2,
    execution_time_ms: null,
    duration_ms: 0.4,
    error: null,
  };
  const { service } = serviceFor([{ type: "valid", output: llmOutput() }]);
  const result = await evaluate(service, {
    validationResult: validationFor({ planEvidence }),
  });

  assert.deepEqual(result.objective_assessment.plan_evidence, planEvidence);
  assert.equal(result.objective_assessment.plan_evidence.analyze, false);
});
