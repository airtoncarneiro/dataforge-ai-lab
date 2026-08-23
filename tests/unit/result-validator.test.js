import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createExercise } from "../../src/domain/index.js";
import {
  createExerciseValidationMetadata,
  toLearnerExercise,
} from "../../src/exercise/index.js";
import {
  RESULT_VALIDATOR_POLICY_VERSION,
  ResultValidator,
  ResultValidatorConfigurationError,
  compareResultRows,
} from "../../src/result-validator/index.js";
import { SqlPolicy } from "../../src/sandbox/sql-policy.js";

const NOW = "2026-08-23T12:00:00.000Z";
const REFERENCE_SQL = "SELECT customer_id, name FROM customers";
const STUDENT_SQL = "SELECT customer_id, name FROM customers WHERE customer_id > 0";

function publicExercise({ strategy = "RESULT_SET", concepts = ["select"] } = {}) {
  return toLearnerExercise(createExercise({
    id: `exercise:${strategy.toLowerCase()}`,
    concepts,
    difficulty: 2,
    objective: "Retornar os dados solicitados pelo exercício.",
    statement: "Na relação customers, retorne o identificador e o nome de cada cliente disponível.",
    expected_skills: concepts,
    validation_strategy: strategy,
    evaluation_notes: [],
    reference_solution: null,
    created_at: NOW,
  }));
}

function metadata({
  strategy = "RESULT_SET",
  columns = ["customer_id", "name"],
  rowCount = null,
  referenceQuery = REFERENCE_SQL,
  concepts = ["select"],
  constraints = [],
} = {}) {
  return createExerciseValidationMetadata({
    expected_columns: columns,
    comparison_mode: strategy,
    ordering_required: strategy === "ORDERED_RESULT",
    expected_row_count: rowCount,
    reference_query: referenceQuery,
    concepts_evaluated: concepts,
    source_relations: ["customers"],
    constraints,
  });
}

function ok(rows, columns = ["customer_id", "name"], overrides = {}) {
  return {
    status: "ok",
    columns,
    rows,
    row_count: rows.length,
    truncated: false,
    duration_ms: 1.25,
    error: null,
    ...overrides,
  };
}

function error(category, sqlstate = null) {
  return {
    status: "error",
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    duration_ms: 0.5,
    error: { category, sqlstate, message: "Erro sanitizado pelo Sandbox." },
  };
}

function plan(overrides = {}) {
  return {
    status: "ok",
    analyze: false,
    plan: {
      node_type: "Index Scan",
      relation_name: "orders",
      index_name: "idx_orders_ordered_at",
      startup_cost: 0.1,
      total_cost: 12.4,
      plan_rows: 3,
      plan_width: 16,
      subplan_name: null,
      plans: [],
    },
    planning_time_ms: 0.2,
    execution_time_ms: null,
    duration_ms: 0.8,
    error: null,
    ...overrides,
  };
}

class FakeSandbox {
  constructor({ executions, explainResult = plan() }) {
    this.policy = new SqlPolicy();
    this.executions = new Map(Object.entries(executions));
    this.explainResult = explainResult;
    this.executeCalls = [];
    this.explainCalls = [];
  }

  async execute(sql) {
    this.executeCalls.push(sql);
    const result = this.executions.get(sql);
    if (!result) throw new Error(`Unexpected SQL in fake sandbox: ${sql}`);
    return structuredClone(result);
  }

  async explain(sql, options) {
    this.explainCalls.push({ sql, options });
    return structuredClone(this.explainResult);
  }
}

function validatorFor({ reference = ok([]), student = ok([]), studentSql = STUDENT_SQL, ...rest }) {
  const sandbox = new FakeSandbox({
    executions: {
      [REFERENCE_SQL]: reference,
      [studentSql]: student,
    },
    ...rest,
  });
  return { validator: new ResultValidator({ sandbox }), sandbox };
}

async function validate(validator, {
  exercise = publicExercise(),
  trustedMetadata = metadata(),
  studentSql = STUDENT_SQL,
} = {}) {
  return validator.validate({
    exercise,
    trustedValidationMetadata: trustedMetadata,
    studentSql,
  });
}

test("aceita resposta correta e retorna contrato objetivo versionado", async () => {
  const rows = [
    { customer_id: 1, name: "Ana" },
    { customer_id: 2, name: "Bruno" },
  ];
  const { validator, sandbox } = validatorFor({ reference: ok(rows), student: ok(rows) });

  const result = await validate(validator);

  assert.equal(result.status, "correct");
  assert.equal(result.correct, true);
  assert.equal(result.validator_policy_version, RESULT_VALIDATOR_POLICY_VERSION);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(sandbox.executeCalls, [REFERENCE_SQL, STUDENT_SQL]);
  assert.equal(sandbox.explainCalls.length, 0);
});

test("RESULT_SET ignora ordem mas preserva duplicatas", async () => {
  const expected = [
    { customer_id: 1, name: "Ana" },
    { customer_id: 1, name: "Ana" },
    { customer_id: 2, name: null },
  ];
  const actual = [expected[2], expected[0], expected[1]];
  const { validator } = validatorFor({ reference: ok(expected), student: ok(actual) });

  const result = await validate(validator);

  assert.equal(result.status, "correct");
});

test("detecta resultado incorreto com mesma quantidade de linhas", async () => {
  const expected = [{ customer_id: 1, name: "Ana" }];
  const actual = [{ customer_id: 1, name: "Outra" }];
  const { validator } = validatorFor({ reference: ok(expected), student: ok(actual) });

  const result = await validate(validator);

  assert.equal(result.status, "incorrect_result");
  assert.equal(result.correct, false);
  assert.equal(result.mismatches[0].code, "incorrect_result");
});

test("diferencia colunas erradas", async () => {
  const expected = [{ customer_id: 1, name: "Ana" }];
  const actual = [{ id: 1, name: "Ana" }];
  const { validator } = validatorFor({
    reference: ok(expected),
    student: ok(actual, ["id", "name"]),
  });

  const result = await validate(validator);

  assert.equal(result.status, "wrong_columns");
  assert.equal(result.mismatches[0].code, "wrong_columns");
});

test("coluna ausente continua wrong_columns mesmo com constraint de resultado", async () => {
  const expected = [{ customer_id: 1, name: "Ana" }];
  const actual = [{ id: 1, name: "Ana" }];
  const { validator } = validatorFor({
    reference: ok(expected),
    student: ok(actual, ["id", "name"]),
  });
  const trustedMetadata = metadata({
    constraints: [{
      kind: "result_property",
      target: "result.column:customer_id.null_count",
      operator: "equals",
      value: 0,
    }],
  });

  const result = await validate(validator, { trustedMetadata });

  assert.equal(result.status, "wrong_columns");
  assert.equal(result.constraints[0].actual, "missing_column");
});

test("diferencia row count errado", async () => {
  const expected = [
    { customer_id: 1, name: "Ana" },
    { customer_id: 2, name: "Bruno" },
  ];
  const { validator } = validatorFor({ reference: ok(expected), student: ok(expected.slice(0, 1)) });

  const result = await validate(validator);

  assert.equal(result.status, "wrong_row_count");
  assert.equal(result.expected_summary.expected_row_count, 2);
});

test("ORDERED_RESULT aceita ordem correta", async () => {
  const rows = [
    { customer_id: 1, name: "Ana" },
    { customer_id: 2, name: "Bruno" },
  ];
  const { validator } = validatorFor({ reference: ok(rows), student: ok(rows) });

  const result = await validate(validator, {
    exercise: publicExercise({ strategy: "ORDERED_RESULT" }),
    trustedMetadata: metadata({ strategy: "ORDERED_RESULT" }),
  });

  assert.equal(result.status, "correct");
});

test("ORDERED_RESULT diferencia ordering mismatch de conteúdo incorreto", async () => {
  const expected = [
    { customer_id: 1, name: "Ana" },
    { customer_id: 2, name: "Bruno" },
  ];
  const { validator } = validatorFor({
    reference: ok(expected),
    student: ok([...expected].reverse()),
  });

  const result = await validate(validator, {
    exercise: publicExercise({ strategy: "ORDERED_RESULT" }),
    trustedMetadata: metadata({ strategy: "ORDERED_RESULT" }),
  });

  assert.equal(result.status, "ordering_mismatch");
});

test("canonicalização trata NULL, números, strings, datas e timestamps tipadamente", () => {
  const expected = [{
    nullable: null,
    amount: 10,
    label: "10",
    day: "2026-08-23",
    instant: new Date("2026-08-23T12:00:00.000Z"),
  }];
  const actual = [{
    nullable: null,
    amount: 10,
    label: "10",
    day: "2026-08-23",
    instant: "2026-08-23T12:00:00Z",
  }];
  const columns = ["nullable", "amount", "label", "day", "instant"];

  assert.equal(compareResultRows({ expectedRows: expected, actualRows: actual, columns, ordered: true }).passed, true);
  assert.equal(compareResultRows({
    expectedRows: expected,
    actualRows: [{ ...actual[0], amount: "10" }],
    columns,
    ordered: true,
  }).passed, false);
});

test("resultado vazio é comparado corretamente", async () => {
  const { validator } = validatorFor({ reference: ok([]), student: ok([]) });

  const result = await validate(validator);

  assert.equal(result.status, "correct");
  assert.equal(result.actual_summary.row_count, 0);
});

test("constraint JOIN rejeita query coincidentemente correta sem JOIN", async () => {
  const rows = [{ customer_id: 1, name: "Ana" }];
  const { validator } = validatorFor({ reference: ok(rows), student: ok(rows) });
  const trustedMetadata = metadata({
    constraints: [{
      kind: "query_structure",
      target: "query.has_join",
      operator: "equals",
      value: true,
    }],
  });

  const result = await validate(validator, { trustedMetadata });

  assert.equal(result.status, "constraint_violation");
  assert.equal(result.constraints[0].actual, false);
});

test("constraint JOIN aceita sintaxe diferente quando resultado e propriedade satisfazem", async () => {
  const sql = "SELECT c.customer_id, c.name FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id, c.name";
  const rows = [{ customer_id: 1, name: "Ana" }];
  const { validator } = validatorFor({ reference: ok(rows), student: ok(rows), studentSql: sql });
  const trustedMetadata = metadata({
    constraints: [{
      kind: "query_structure",
      target: "query.has_join",
      operator: "equals",
      value: true,
    }],
  });

  const result = await validate(validator, { trustedMetadata, studentSql: sql });

  assert.equal(result.status, "correct");
  assert.equal(result.constraints[0].passed, true);
});

test("constraints detectam GROUP BY e window function pela AST existente", async () => {
  const cases = [
    {
      sql: "SELECT customer_id, count(*) AS name FROM orders GROUP BY customer_id",
      target: "query.has_group_by",
    },
    {
      sql: "SELECT employee_id AS customer_id, row_number() OVER (ORDER BY employee_id) AS name FROM employees",
      target: "query.has_window_function",
    },
  ];
  for (const item of cases) {
    const rows = [{ customer_id: 1, name: 1 }];
    const { validator } = validatorFor({ reference: ok(rows), student: ok(rows), studentSql: item.sql });
    const result = await validate(validator, {
      studentSql: item.sql,
      trustedMetadata: metadata({
        constraints: [{
          kind: "query_structure",
          target: item.target,
          operator: "equals",
          value: true,
        }],
      }),
    });
    assert.equal(result.status, "correct", item.target);
  }
});

test("classifica erro de sintaxe do aluno como execution_error", async () => {
  const sql = "SELEC customer_id FROM customers";
  const { validator } = validatorFor({
    reference: ok([]),
    student: error("syntax_error", "42601"),
    studentSql: sql,
  });

  const result = await validate(validator, { studentSql: sql });

  assert.equal(result.status, "execution_error");
  assert.equal(result.execution.error.category, "syntax_error");
});

test("preserva classificação security violation", async () => {
  const sql = "DELETE FROM customers";
  const { validator } = validatorFor({
    reference: ok([]),
    student: error("security_violation"),
    studentSql: sql,
  });

  const result = await validate(validator, { studentSql: sql });

  assert.equal(result.status, "security_violation");
});

test("preserva classificação timeout", async () => {
  const sql = "SELECT pg_sleep(10)";
  const { validator } = validatorFor({
    reference: ok([]),
    student: error("timeout", "57014"),
    studentSql: sql,
  });

  const result = await validate(validator, { studentSql: sql });

  assert.equal(result.status, "timeout");
});

test("reference query inválida é problema interno e aluno não é executado", async () => {
  const invalidReference = "SELEC * FORM customers";
  const sandbox = new FakeSandbox({ executions: { [invalidReference]: error("syntax_error", "42601") } });
  const validator = new ResultValidator({ sandbox });

  const result = await validate(validator, {
    trustedMetadata: metadata({ referenceQuery: invalidReference }),
  });

  assert.equal(result.status, "reference_validation_error");
  assert.equal(result.mismatches[0].code, "reference_query_invalid");
  assert.deepEqual(sandbox.executeCalls, [invalidReference]);
});

test("erro de execução da reference query é classificado sem vazar seu conteúdo", async () => {
  const brokenReference = "SELECT missing_column AS customer_id, name FROM customers";
  const sandbox = new FakeSandbox({ executions: { [brokenReference]: error("execution_error", "42703") } });
  const validator = new ResultValidator({ sandbox });

  const result = await validate(validator, {
    trustedMetadata: metadata({ referenceQuery: brokenReference }),
  });

  assert.equal(result.status, "reference_validation_error");
  assert.equal(result.mismatches[0].code, "reference_execution_error");
  assert.doesNotMatch(JSON.stringify(result), /missing_column|SELECT|customers/u);
});

test("PLAN_CONSTRAINT reutiliza EXPLAIN sem ANALYZE", async () => {
  const rows = [{ customer_id: 1, name: "Ana" }];
  const { validator, sandbox } = validatorFor({ reference: ok(rows), student: ok(rows) });
  const exercise = publicExercise({ strategy: "PLAN_CONSTRAINT" });
  const trustedMetadata = metadata({
    strategy: "PLAN_CONSTRAINT",
    constraints: [{
      kind: "plan_property",
      target: "plan.index_names",
      operator: "contains",
      value: "idx_orders_ordered_at",
    }],
  });

  const result = await validate(validator, { exercise, trustedMetadata });

  assert.equal(result.status, "correct");
  assert.equal(result.plan_evidence.analyze, false);
  assert.deepEqual(sandbox.explainCalls, [{ sql: STUDENT_SQL, options: { analyze: false } }]);
});

test("resultado nunca contém reference query ou solução", async () => {
  const rows = [{ customer_id: 1, name: "Ana" }];
  const { validator } = validatorFor({ reference: ok(rows), student: ok(rows) });

  const result = await validate(validator);
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /SELECT customer_id|reference_query|reference_solution/iu);
});

test("entradas e resultado permanecem imutáveis", async () => {
  const rows = [{ customer_id: 1, name: "Ana" }];
  const exercise = publicExercise();
  const trustedMetadata = metadata();
  const snapshots = [JSON.stringify(exercise), JSON.stringify(trustedMetadata)];
  const { validator } = validatorFor({ reference: ok(rows), student: ok(rows) });

  const result = await validate(validator, { exercise, trustedMetadata });

  assert.equal(JSON.stringify(exercise), snapshots[0]);
  assert.equal(JSON.stringify(trustedMetadata), snapshots[1]);
  assert.ok(Object.isFrozen(result));
  assert.throws(() => result.mismatches.push({}), TypeError);
});

test("mesmas evidências produzem validação determinística", async () => {
  const rows = [{ customer_id: 1, name: "Ana" }];
  const first = validatorFor({ reference: ok(rows), student: ok(rows) });
  const second = validatorFor({ reference: ok(rows), student: ok(rows) });

  assert.deepEqual(await validate(first.validator), await validate(second.validator));
});

test("API rejeita metadata alternativa que poderia vir do aluno", async () => {
  const { validator } = validatorFor({ reference: ok([]), student: ok([]) });

  await assert.rejects(
    validator.validate({
      exercise: publicExercise(),
      trustedValidationMetadata: metadata(),
      studentSql: STUDENT_SQL,
      validationMetadata: { expected_columns: [] },
    }),
    (error) => error instanceof ResultValidatorConfigurationError
      && error.code === "unknown_field",
  );
});

test("módulo não importa LLM, Learner Model, B10 ou State Machine", async () => {
  const source = await readFile(
    new URL("../../src/result-validator/result-validator.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /\.\.\/llm|learner-model|adaptive-decision|state-machine/u);
});
