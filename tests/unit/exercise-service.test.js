import assert from "node:assert/strict";
import test from "node:test";

import { createAdaptiveDecision } from "../../src/adaptive-decision/index.js";
import { createLearnerState } from "../../src/domain/index.js";
import {
  EXERCISE_POLICY_VERSION,
  ExerciseService,
  ExerciseValidationError,
  createExerciseValidationMetadata,
  exerciseDifficultyFor,
  toLearnerExercise,
} from "../../src/exercise/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../../src/knowledge-graph/index.js";
import { FakeLlmProvider, LlmAdapter } from "../../src/llm/index.js";
import { createTutorPolicyContextBuilder } from "../../src/tutor-policy/index.js";

const NOW = "2026-08-23T12:00:00.000Z";
const policyBuilder = await createTutorPolicyContextBuilder();

function learnerState({
  currentConcept = "select",
  mastery = 0.4,
  confidence = "low",
  conceptOverrides = {},
} = {}) {
  const concepts = SQL_KNOWLEDGE_GRAPH.getConcepts().map((node) => {
    const specific = conceptOverrides[node.id] ?? {};
    const isCurrent = node.id === currentConcept;
    return {
      id: `concept-state:${node.id}`,
      concept: node.id,
      mastery: specific.mastery ?? (isCurrent ? mastery : 0.9),
      confidence: specific.confidence ?? (isCurrent ? confidence : "medium"),
      misconceptions: [],
      evidence_ids: [],
      evidence_summary: {
        positive_attempts: 0,
        negative_attempts: 0,
        consecutive_positive: 0,
        consecutive_negative: 0,
      },
      created_at: NOW,
      updated_at: NOW,
    };
  });
  return createLearnerState({
    id: "learner-state:exercise-tests",
    session_id: "session:exercise-tests",
    learning_goal: "Quero aprender SQL",
    concepts,
    created_at: NOW,
    updated_at: NOW,
  });
}

function pedagogicalContext(overrides = {}) {
  return {
    phase: "PRACTICE",
    learning_goal: "Quero aprender SQL",
    integration_concepts: [],
    scenario_hint: "Use o dataset educacional de comércio.",
    recent_messages: [],
    ...overrides,
  };
}

function outputFor({
  id = "exercise-select-1",
  concepts = ["select"],
  difficulty = 1,
  objective = "Projetar colunas específicas de uma relação.",
  statement = "Na relação customers, liste o identificador e o nome de cada cliente cadastrado.",
  expectedSkills = ["select"],
  strategy = "RESULT_SET",
  expectedColumns = ["customer_id", "name"],
  orderingRequired = false,
  expectedRowCount = null,
  referenceQuery = "SELECT customer_id, name FROM customers",
  sourceRelations = ["customers"],
  constraints = [],
  extra = {},
} = {}) {
  return {
    id,
    target_concepts: concepts,
    difficulty,
    objective,
    statement,
    expected_skills: expectedSkills,
    validation_strategy: strategy,
    evaluation_notes: ["Verificar projeção das colunas solicitadas."],
    validation_metadata: {
      expected_columns: expectedColumns,
      comparison_mode: strategy,
      ordering_required: orderingRequired,
      expected_row_count: expectedRowCount,
      reference_query: referenceQuery,
      concepts_evaluated: concepts,
      source_relations: sourceRelations,
      constraints,
    },
    ...extra,
  };
}

function joinOutput({ difficulty = 3 } = {}) {
  return outputFor({
    id: "exercise-join-1",
    concepts: ["join"],
    difficulty,
    objective: "Combinar clientes com os respectivos pedidos.",
    statement: "Usando customers e orders, retorne o nome do cliente e o identificador de cada pedido existente.",
    expectedSkills: ["join", "select"],
    expectedColumns: ["name", "order_id"],
    referenceQuery: "SELECT c.name, o.order_id FROM customers c JOIN orders o ON o.customer_id = c.customer_id",
    sourceRelations: ["customers", "orders"],
  });
}

function groupByOutput({ difficulty = 3 } = {}) {
  return outputFor({
    id: "exercise-group-by-1",
    concepts: ["group_by"],
    difficulty,
    objective: "Resumir produtos por categoria.",
    statement: "Na relação products, mostre cada category_id e a quantidade de produtos pertencente à categoria.",
    expectedSkills: ["group_by", "aggregate_functions", "select"],
    expectedColumns: ["category_id", "product_count"],
    referenceQuery: "SELECT category_id, count(*) AS product_count FROM products GROUP BY category_id",
    sourceRelations: ["products"],
  });
}

function windowOutput({ difficulty = 5 } = {}) {
  return outputFor({
    id: "exercise-window-1",
    concepts: ["window_functions"],
    difficulty,
    objective: "Rankear salários dentro de cada departamento.",
    statement: "Na relação employees, retorne employee_id, department_id, salary e a posição salarial dentro do departamento.",
    expectedSkills: ["window_functions", "order_by", "select"],
    expectedColumns: ["employee_id", "department_id", "salary", "salary_rank"],
    referenceQuery: "SELECT employee_id, department_id, salary, rank() OVER (PARTITION BY department_id ORDER BY salary DESC) AS salary_rank FROM employees",
    sourceRelations: ["employees"],
  });
}

function adapterFor(scenarios, { timeoutMs = 100, adapterRetries = 0 } = {}) {
  const provider = new FakeLlmProvider({ scenarios });
  const adapter = new LlmAdapter({
    provider,
    policyVersion: "tutor-policy-v0.1",
    timeoutMs,
    maxRetries: adapterRetries,
  });
  return { adapter, provider };
}

function serviceFor(scenarios, options = {}) {
  const { adapter, provider } = adapterFor(scenarios, options);
  const service = new ExerciseService({
    adapter,
    policyBuilder,
    knowledgeGraph: SQL_KNOWLEDGE_GRAPH,
    clock: () => NOW,
    maxGenerationAttempts: options.maxGenerationAttempts ?? 3,
    sqlPolicy: options.sqlPolicy,
  });
  return { service, provider };
}

async function generate(service, overrides = {}) {
  return service.generate({
    currentConcept: "select",
    learnerState: learnerState(),
    targetDifficulty: "low",
    pedagogicalContext: pedagogicalContext(),
    ...overrides,
  });
}

test("gera exercício simples válido e compatível com o contrato B07", async () => {
  const { service } = serviceFor([{ type: "valid", output: outputFor() }]);

  const result = await generate(service);

  assert.equal(result.status, "ok");
  assert.equal(result.policy_version, EXERCISE_POLICY_VERSION);
  assert.deepEqual(result.exercise.concepts, ["select"]);
  assert.equal(result.exercise.difficulty, 1);
  assert.equal(result.exercise.validation_strategy, "RESULT_SET");
  assert.equal(result.exercise.reference_solution, null);
  assert.equal(result.validation_metadata.reference_query, "SELECT customer_id, name FROM customers");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.exercise));
  assert.ok(Object.isFrozen(result.validation_metadata));
});

test("informa ao gerador o schema educacional permitido", async () => {
  const { service, provider } = serviceFor([{ type: "valid", output: outputFor() }]);

  await generate(service);

  const directive = JSON.parse(provider.calls[0].messages.at(-1).content);
  assert.equal(directive.available_schema.name, "education");
  assert.deepEqual(directive.available_schema.relations.customers, [
    "customer_id", "name", "email", "city", "created_at",
  ]);
  assert.deepEqual(Object.keys(directive.available_schema.relations), [
    "categories", "customers", "departments", "employees", "order_items", "orders", "products",
  ]);
  assert.deepEqual(directive.supported_validation_constraints.query_structure_targets, [
    "query.has_join",
    "query.has_group_by",
    "query.has_window_function",
    "query.has_order_by",
    "query.has_cte",
    "query.has_subquery",
    "query.has_aggregate",
    "query.has_where",
    "query.has_having",
    "query.has_distinct",
  ]);
  assert.deepEqual(directive.supported_validation_constraints.result_property_targets, [
    "result.row_count",
    "result.columns",
    "result.column:<expected_column>.null_count",
    "result.column:<expected_column>.distinct_count",
    "result.column:<expected_column>.min",
    "result.column:<expected_column>.max",
    "result.column:<expected_column>.values",
  ]);
});

test("gera exercício de JOIN com relações e skills coerentes", async () => {
  const state = learnerState({ currentConcept: "join", mastery: 0.6, confidence: "medium" });
  const { service } = serviceFor([{ type: "valid", output: joinOutput() }]);

  const result = await generate(service, {
    currentConcept: "join",
    learnerState: state,
    targetDifficulty: "medium",
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.exercise.concepts, ["join"]);
  assert.deepEqual(result.validation_metadata.source_relations, ["customers", "orders"]);
});

test("gera exercício de GROUP BY", async () => {
  const state = learnerState({
    currentConcept: "group_by",
    mastery: 0.6,
    confidence: "medium",
  });
  const { service } = serviceFor([{ type: "valid", output: groupByOutput() }]);

  const result = await generate(service, {
    currentConcept: "group_by",
    learnerState: state,
    targetDifficulty: "medium",
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.exercise.expected_skills, [
    "group_by",
    "aggregate_functions",
    "select",
  ]);
});

test("gera exercício de window function para mastery alto", async () => {
  const state = learnerState({
    currentConcept: "window_functions",
    mastery: 0.9,
    confidence: "high",
  });
  const { service } = serviceFor([{ type: "valid", output: windowOutput() }]);

  const result = await generate(service, {
    currentConcept: "window_functions",
    learnerState: state,
    targetDifficulty: "high",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.exercise.difficulty, 5);
});

test("política de difficulty cobre baixa, média e alta", () => {
  assert.equal(exerciseDifficultyFor({
    conceptState: { mastery: 0.2, confidence: "low" },
    targetDifficulty: "low",
  }), 1);
  assert.equal(exerciseDifficultyFor({
    conceptState: { mastery: 0.6, confidence: "medium" },
    targetDifficulty: "medium",
  }), 3);
  assert.equal(exerciseDifficultyFor({
    conceptState: { mastery: 0.9, confidence: "high" },
    targetDifficulty: "high",
  }), 5);
});

test("mastery baixo limita difficulty e não aceita skill avançada", async () => {
  const state = learnerState({ currentConcept: "where", mastery: 0.2, confidence: "low" });
  const valid = outputFor({
    id: "exercise-where-low",
    concepts: ["where"],
    difficulty: 2,
    objective: "Filtrar clientes por cidade.",
    statement: "Na relação customers, retorne customer_id e name apenas para clientes da cidade informada.",
    expectedSkills: ["where", "select"],
    expectedColumns: ["customer_id", "name"],
    referenceQuery: "SELECT customer_id, name FROM customers WHERE city = 'Recife'",
  });
  const { service } = serviceFor([{ type: "valid", output: valid }]);

  const result = await generate(service, {
    currentConcept: "where",
    learnerState: state,
    targetDifficulty: "high",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.exercise.difficulty, 2);
  assert.doesNotMatch(result.exercise.expected_skills.join(" "), /join|window/u);
});

test("rejeita conceito atual com prerequisite bloqueado antes de chamar a LLM", async () => {
  const state = learnerState({
    currentConcept: "group_by",
    mastery: 0.4,
    conceptOverrides: { aggregate_functions: { mastery: 0.79, confidence: "high" } },
  });
  const { service, provider } = serviceFor([{ type: "valid", output: groupByOutput({ difficulty: 1 }) }]);

  await assert.rejects(
    generate(service, {
      currentConcept: "group_by",
      learnerState: state,
      targetDifficulty: "low",
    }),
    (error) => error instanceof ExerciseValidationError && error.code === "blocked_prerequisite",
  );
  assert.equal(provider.callCount, 0);
});

test("rejeita target concept inexistente antes de chamar a LLM", async () => {
  const { service, provider } = serviceFor([{ type: "valid", output: outputFor() }]);

  await assert.rejects(
    generate(service, { currentConcept: "nonexistent_concept" }),
    /Conceito inexistente/u,
  );
  assert.equal(provider.callCount, 0);
});

test("regenera saída incompatível com o schema da LLM", async () => {
  const invalid = { ...outputFor(), unknown_field: true };
  const { service, provider } = serviceFor([
    { type: "valid", output: invalid },
    { type: "valid", output: outputFor() },
  ]);

  const result = await generate(service);

  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(provider.callCount, 2);
});

test("orienta a regeneração após reference query fora do schema permitido", async () => {
  const invalid = outputFor({
    statement: "Na relação products, retorne o nome de cada produto para validar a consulta solicitada.",
    referenceQuery: "SELECT nome FROM produtos",
    sourceRelations: ["products"],
  });
  const { service, provider } = serviceFor([
    { type: "valid", output: invalid },
    { type: "valid", output: outputFor() },
  ]);

  const result = await generate(service);

  assert.equal(result.status, "ok");
  const correction = JSON.parse(provider.calls[1].messages.at(-1).content);
  assert.equal(correction.rejected_code, "unsafe_reference_query");
  assert.match(correction.instruction, /available_schema/u);
});

test("rejeita constraint estrutural não suportada e regenera", async () => {
  const invalid = outputFor({
    constraints: [{
      kind: "query_structure",
      target: "select_clause",
      operator: "contains",
      value: "name",
    }],
  });
  const { service, provider } = serviceFor([
    { type: "valid", output: invalid },
    { type: "valid", output: outputFor() },
  ]);

  const result = await generate(service);

  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  const correction = JSON.parse(provider.calls[1].messages.at(-1).content);
  assert.equal(correction.rejected_code, "unsupported_constraint");
});

test("normaliza booleano textual de constraint estrutural", async () => {
  const metadata = createExerciseValidationMetadata({
    expected_columns: ["name", "unit_price"],
    comparison_mode: "RESULT_SET",
    ordering_required: false,
    expected_row_count: null,
    reference_query: "SELECT name, unit_price FROM products WHERE unit_price > 50.00",
    concepts_evaluated: ["where"],
    source_relations: ["products"],
    constraints: [{
      kind: "query_structure",
      target: "query.has_where",
      operator: "equals",
      value: "true",
    }],
  });

  assert.equal(metadata.constraints[0].value, true);
});

test("rejeita reference_solution no payload proposto pela LLM", async () => {
  const leaked = { ...outputFor(), reference_solution: "SELECT * FROM customers" };
  const { service } = serviceFor(
    [{ type: "valid", output: leaked }],
    { maxGenerationAttempts: 1 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "generation_error");
  assert.equal(result.error.code, "invalid_llm_output");
  assert.equal(result.exercise, null);
});

test("rejeita solução de referência reproduzida no statement", async () => {
  const referenceQuery = "SELECT customer_id, name FROM customers";
  const leaked = outputFor({
    statement: `Na relação customers, use como resposta: ${referenceQuery} para listar os clientes.`,
    referenceQuery,
  });
  const { service } = serviceFor(
    [{ type: "valid", output: leaked }],
    { maxGenerationAttempts: 1 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "reference_solution_leak");
});

test("rejeita validation metadata incompleta", async () => {
  const incomplete = outputFor({ referenceQuery: null });
  const { service } = serviceFor(
    [{ type: "valid", output: incomplete }],
    { maxGenerationAttempts: 1 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "missing_reference_query");
});

test("rejeita enunciado estruturalmente ambíguo sobre a relação usada", async () => {
  const ambiguous = outputFor({
    statement: "Liste o identificador e o nome de todos os registros disponíveis no dataset educacional informado.",
  });
  const { service } = serviceFor(
    [{ type: "valid", output: ambiguous }],
    { maxGenerationAttempts: 1 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "ambiguous_statement");
});

test("rejeita expected_skills inconsistente com alvos e prerequisites", async () => {
  const inconsistent = outputFor({ expectedSkills: ["select", "window_functions"] });
  const { service } = serviceFor(
    [{ type: "valid", output: inconsistent }],
    { maxGenerationAttempts: 1 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.code, "inconsistent_expected_skill");
});

test("regeneration respeita limite e não entra em loop", async () => {
  const invalid = outputFor({ referenceQuery: null });
  const { service, provider } = serviceFor(
    [{ type: "valid", output: invalid }],
    { maxGenerationAttempts: 2 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.attempts, 2);
  assert.equal(provider.callCount, 2);
});

test("FakeLlmProvider mantém geração determinística", async () => {
  const first = serviceFor([{ type: "valid", output: outputFor() }]);
  const second = serviceFor([{ type: "valid", output: outputFor() }]);

  const [left, right] = await Promise.all([generate(first.service), generate(second.service)]);

  assert.deepEqual(left, right);
  assert.deepEqual(first.provider.calls, second.provider.calls);
});

test("timeout retorna erro estruturado e sanitizado", async () => {
  const { service, provider } = serviceFor(
    [{ type: "timeout" }],
    { timeoutMs: 10, maxGenerationAttempts: 3 },
  );

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "llm_error");
  assert.equal(result.error.code, "request_timeout");
  assert.equal(provider.callCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /stack|postgresql:\/\/|sk-/iu);
});

test("provider error retorna erro estruturado sem payload interno", async () => {
  const { service } = serviceFor([{ type: "provider_error" }]);

  const result = await generate(service);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "llm_error");
  assert.equal(result.error.code, "fake_provider_error");
  assert.equal(result.exercise, null);
  assert.equal(result.validation_metadata, null);
});

test("exercício e metadata retornados são imutáveis", async () => {
  const { service } = serviceFor([{ type: "valid", output: outputFor() }]);
  const result = await generate(service);

  assert.throws(() => {
    result.exercise.concepts.push("join");
  }, TypeError);
  assert.throws(() => {
    result.validation_metadata.reference_query = "DELETE FROM customers";
  }, TypeError);
});

test("LearnerState de entrada não sofre mutação", async () => {
  const state = learnerState();
  const snapshot = JSON.stringify(state);
  const { service } = serviceFor([{ type: "valid", output: outputFor() }]);

  await generate(service, { learnerState: state });

  assert.equal(JSON.stringify(state), snapshot);
});

test("componente apenas valida SQL trusted e nunca executa SQL", async () => {
  const calls = [];
  const sqlPolicy = {
    allowedRelations: new Set(["customers"]),
    validate(sql) {
      calls.push(sql);
      return {
        ast: { type: "select", from: [{ type: "table", name: { name: "customers" } }] },
        sql,
      };
    },
  };
  const { service } = serviceFor(
    [{ type: "valid", output: outputFor() }],
    { sqlPolicy },
  );

  const result = await generate(service);

  assert.equal(result.status, "ok");
  assert.deepEqual(calls, ["SELECT customer_id, name FROM customers"]);
  assert.equal("execute" in sqlPolicy, false);
});

test("payload público omite reference query, reference solution e notas internas", async () => {
  const { service } = serviceFor([{ type: "valid", output: outputFor() }]);
  const result = await generate(service);

  const learnerPayload = toLearnerExercise(result.exercise);
  const serialized = JSON.stringify(learnerPayload);

  assert.deepEqual(Object.keys(learnerPayload), [
    "id",
    "concepts",
    "difficulty",
    "objective",
    "statement",
    "expected_skills",
    "validation_strategy",
    "created_at",
  ]);
  assert.doesNotMatch(serialized, /reference|SELECT customer_id|evaluation_notes/iu);
});

test("conceito de integração deve estar explicitamente dominado", async () => {
  const state = learnerState({
    currentConcept: "where",
    mastery: 0.6,
    confidence: "medium",
    conceptOverrides: { join: { mastery: 0.7, confidence: "high" } },
  });
  const { service, provider } = serviceFor([{ type: "valid", output: outputFor() }]);

  await assert.rejects(
    generate(service, {
      currentConcept: "where",
      learnerState: state,
      targetDifficulty: "medium",
      pedagogicalContext: pedagogicalContext({ integration_concepts: ["join"] }),
    }),
    (error) => (
      error instanceof ExerciseValidationError
      && error.code === "integration_concept_not_mastered"
    ),
  );
  assert.equal(provider.callCount, 0);
});

test("decisão B10 practice mantém o conceito e não é alterada", async () => {
  const decision = createAdaptiveDecision({
    action: "practice",
    current_concept: "select",
    next_concept: null,
    reason_codes: ["mastery_partial"],
    rationale: "Prática adicional necessária.",
    blocking_prerequisites: [],
    policy_version: "adaptive-policy-v1",
  });
  const snapshot = JSON.stringify(decision);
  const { service, provider } = serviceFor([{ type: "valid", output: outputFor() }]);

  const result = await generate(service, { adaptiveDecision: decision });

  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(decision), snapshot);
  const directive = JSON.parse(provider.calls[0].messages.at(-1).content);
  assert.equal(directive.adaptive_decision.action, "practice");
  assert.equal(directive.current_concept, "select");
});

test("decisão B10 advance autoriza somente o next_concept", async () => {
  const state = learnerState({ currentConcept: "where", mastery: 0.6, confidence: "medium" });
  const decision = createAdaptiveDecision({
    action: "advance",
    current_concept: "select",
    next_concept: "where",
    reason_codes: ["operational_mastery", "prerequisites_satisfied"],
    rationale: "Próximo conceito disponível.",
    blocking_prerequisites: [],
    policy_version: "adaptive-policy-v1",
  });
  const generated = outputFor({
    id: "exercise-where-advance",
    concepts: ["where"],
    difficulty: 3,
    objective: "Aplicar filtros simples a clientes.",
    statement: "Na relação customers, retorne customer_id e name somente para registros com city preenchida.",
    expectedSkills: ["where", "select"],
    expectedColumns: ["customer_id", "name"],
    referenceQuery: "SELECT customer_id, name FROM customers WHERE city IS NOT NULL",
  });
  const { service } = serviceFor([{ type: "valid", output: generated }]);

  const result = await generate(service, {
    currentConcept: "where",
    learnerState: state,
    targetDifficulty: "medium",
    adaptiveDecision: decision,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.exercise.concepts, ["where"]);
});

test("metadata PLAN_CONSTRAINT exige conceito de otimização e constraint de plano", async () => {
  const state = learnerState({
    currentConcept: "query_optimization",
    mastery: 0.9,
    confidence: "high",
  });
  const plan = outputFor({
    id: "exercise-optimization-1",
    concepts: ["query_optimization"],
    difficulty: 5,
    objective: "Propor uma consulta compatível com uso eficiente de índice.",
    statement: "Na relação orders, filtre ordered_at por um intervalo e preserve uma forma adequada para análise com EXPLAIN.",
    expectedSkills: ["query_optimization", "indexes", "explain", "where", "select"],
    strategy: "PLAN_CONSTRAINT",
    expectedColumns: ["order_id", "ordered_at"],
    referenceQuery: "SELECT order_id, ordered_at FROM orders WHERE ordered_at >= DATE '2025-01-01'",
    sourceRelations: ["orders"],
    constraints: [{
      kind: "plan_property",
      target: "plan.node_type",
      operator: "not_equals",
      value: "Seq Scan",
    }],
  });
  const { service } = serviceFor([{ type: "valid", output: plan }]);

  const result = await generate(service, {
    currentConcept: "query_optimization",
    learnerState: state,
    targetDifficulty: "high",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.exercise.validation_strategy, "PLAN_CONSTRAINT");
  assert.equal(result.validation_metadata.constraints[0].kind, "plan_property");
});

test("contexto B12 permanece estruturado e tools ficam vazias", async () => {
  const { service, provider } = serviceFor([{ type: "valid", output: outputFor() }]);

  await generate(service);

  const request = provider.calls[0];
  const applicationContext = JSON.parse(request.messages[0].content);
  const directive = JSON.parse(request.messages.at(-1).content);
  assert.equal(applicationContext.policy_version, "tutor-policy-v0.1");
  assert.equal(applicationContext.phase, "PRACTICE");
  assert.equal(directive.policy_version, EXERCISE_POLICY_VERSION);
  assert.deepEqual(request.tools, []);
  assert.match(request.instructions, /Do not execute SQL/u);
});
