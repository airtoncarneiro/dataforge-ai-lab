import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createExercise } from "../../src/domain/index.js";
import {
  createExerciseValidationMetadata,
  toLearnerExercise,
} from "../../src/exercise/index.js";
import { ResultValidator } from "../../src/result-validator/index.js";
import { createSqlSandboxFromEnv } from "../../src/sandbox/sql-sandbox.js";

const NOW = "2026-08-23T12:00:00.000Z";
const sandbox = createSqlSandboxFromEnv({
  ...process.env,
  SQL_MENTOR_SANDBOX_TIMEOUT_MS: "50",
  SQL_MENTOR_SANDBOX_MAX_ROWS: "20",
});
const validator = new ResultValidator({ sandbox });

after(async () => {
  await sandbox.close();
});

function exercise({
  strategy = "RESULT_SET",
  concepts = ["select"],
  id = "integration-exercise",
} = {}) {
  return toLearnerExercise(createExercise({
    id,
    concepts,
    difficulty: 3,
    objective: "Validar uma solução SQL com evidência real.",
    statement: "Resolva a consulta solicitada sobre o dataset educacional apresentado.",
    expected_skills: concepts,
    validation_strategy: strategy,
    evaluation_notes: [],
    reference_solution: null,
    created_at: NOW,
  }));
}

function metadata({
  strategy = "RESULT_SET",
  columns,
  referenceQuery,
  rowCount = null,
  concepts = ["select"],
  sourceRelations = ["customers"],
  constraints = [],
}) {
  return createExerciseValidationMetadata({
    expected_columns: columns,
    comparison_mode: strategy,
    ordering_required: strategy === "ORDERED_RESULT",
    expected_row_count: rowCount,
    reference_query: referenceQuery,
    concepts_evaluated: concepts,
    source_relations: sourceRelations,
    constraints,
  });
}

function validate({ exerciseInput = exercise(), metadataInput, studentSql }) {
  return validator.validate({
    exercise: exerciseInput,
    trustedValidationMetadata: metadataInput,
    studentSql,
  });
}

test("aceita resposta correta executada no PostgreSQL", async () => {
  const referenceQuery = "SELECT customer_id, name FROM customers WHERE city = 'Sao Paulo'";
  const result = await validate({
    metadataInput: metadata({ columns: ["customer_id", "name"], referenceQuery }),
    studentSql: referenceQuery,
  });

  assert.equal(result.status, "correct");
  assert.equal(result.execution.status, "ok");
  assert.equal(result.actual_summary.row_count, 2);
});

test("detecta resultado incorreto real", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers WHERE city = 'Sao Paulo'",
    }),
    studentSql: "SELECT customer_id, name FROM customers WHERE city = 'Recife' OR customer_id = 3",
  });

  assert.equal(result.status, "incorrect_result");
});

test("detecta aliases/colunas errados", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers WHERE customer_id = 1",
    }),
    studentSql: "SELECT customer_id AS id, name FROM customers WHERE customer_id = 1",
  });

  assert.equal(result.status, "wrong_columns");
  assert.deepEqual(result.execution.columns, ["id", "name"]);
});

test("detecta row count errado", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers",
      rowCount: 4,
    }),
    studentSql: "SELECT customer_id, name FROM customers WHERE customer_id < 4",
  });

  assert.equal(result.status, "wrong_row_count");
});

test("ORDERED_RESULT aceita ordenação correta", async () => {
  const referenceQuery = "SELECT customer_id, name FROM customers ORDER BY name ASC";
  const result = await validate({
    exerciseInput: exercise({ strategy: "ORDERED_RESULT" }),
    metadataInput: metadata({
      strategy: "ORDERED_RESULT",
      columns: ["customer_id", "name"],
      referenceQuery,
    }),
    studentSql: "SELECT customer_id, name FROM customers ORDER BY name",
  });

  assert.equal(result.status, "correct");
});

test("ORDERED_RESULT detecta ordem incorreta", async () => {
  const result = await validate({
    exerciseInput: exercise({ strategy: "ORDERED_RESULT" }),
    metadataInput: metadata({
      strategy: "ORDERED_RESULT",
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers ORDER BY name ASC",
    }),
    studentSql: "SELECT customer_id, name FROM customers ORDER BY name DESC",
  });

  assert.equal(result.status, "ordering_mismatch");
});

test("compara NULL usando resultado real", async () => {
  const referenceQuery = "SELECT customer_id, email FROM customers ORDER BY customer_id";
  const result = await validate({
    exerciseInput: exercise({ strategy: "ORDERED_RESULT", concepts: ["null"] }),
    metadataInput: metadata({
      strategy: "ORDERED_RESULT",
      columns: ["customer_id", "email"],
      referenceQuery,
      concepts: ["null"],
    }),
    studentSql: "SELECT customer_id, email FROM customers ORDER BY customer_id ASC",
  });

  assert.equal(result.status, "correct");
  assert.equal(result.execution.rows.some((row) => row.email === null), true);
});

test("RESULT_SET preserva linhas duplicadas ao ignorar ordem", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id"],
      referenceQuery: "SELECT customer_id FROM orders ORDER BY order_id",
      sourceRelations: ["orders"],
    }),
    studentSql: "SELECT customer_id FROM orders ORDER BY order_id DESC",
  });

  assert.equal(result.status, "correct");
  assert.equal(result.execution.rows.filter((row) => row.customer_id === 1).length, 2);
});

test("compara resultado vazio", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers WHERE customer_id < 0",
    }),
    studentSql: "SELECT customer_id, name FROM customers WHERE false",
  });

  assert.equal(result.status, "correct");
  assert.equal(result.execution.row_count, 0);
});

test("JOIN exigido é confirmado pela AST", async () => {
  const referenceQuery = "SELECT c.customer_id, c.name FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE o.order_id = 101";
  const trusted = metadata({
    columns: ["customer_id", "name"],
    referenceQuery,
    concepts: ["join"],
    sourceRelations: ["customers", "orders"],
    constraints: [{
      kind: "query_structure",
      target: "query.has_join",
      operator: "equals",
      value: true,
    }],
  });
  const result = await validate({
    exerciseInput: exercise({ concepts: ["join"] }),
    metadataInput: trusted,
    studentSql: referenceQuery,
  });

  assert.equal(result.status, "correct");
  assert.equal(result.constraints[0].actual, true);
});

test("GROUP BY exigido é confirmado pela AST", async () => {
  const referenceQuery = "SELECT customer_id, count(*) AS order_count FROM orders GROUP BY customer_id";
  const result = await validate({
    exerciseInput: exercise({ concepts: ["group_by"] }),
    metadataInput: metadata({
      columns: ["customer_id", "order_count"],
      referenceQuery,
      concepts: ["group_by"],
      sourceRelations: ["orders"],
      constraints: [{
        kind: "query_structure",
        target: "query.has_group_by",
        operator: "equals",
        value: true,
      }],
    }),
    studentSql: referenceQuery,
  });

  assert.equal(result.status, "correct");
});

test("window function exigida é confirmada pela AST", async () => {
  const referenceQuery = "SELECT employee_id, row_number() OVER (ORDER BY salary DESC) AS salary_rank FROM employees";
  const result = await validate({
    exerciseInput: exercise({ concepts: ["window_functions"] }),
    metadataInput: metadata({
      columns: ["employee_id", "salary_rank"],
      referenceQuery,
      concepts: ["window_functions"],
      sourceRelations: ["employees"],
      constraints: [{
        kind: "query_structure",
        target: "query.has_window_function",
        operator: "equals",
        value: true,
      }],
    }),
    studentSql: referenceQuery,
  });

  assert.equal(result.status, "correct");
});

test("query equivalente com sintaxe diferente é aceita", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers WHERE city = 'Sao Paulo'",
      constraints: [{
        kind: "query_structure",
        target: "query.has_where",
        operator: "equals",
        value: true,
      }],
    }),
    studentSql: "SELECT c.customer_id, c.name FROM customers AS c WHERE c.city IN ('Sao Paulo')",
  });

  assert.equal(result.status, "correct");
});

test("resultado coincidentemente correto é rejeitado sem JOIN exigido", async () => {
  const result = await validate({
    exerciseInput: exercise({ concepts: ["join"] }),
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT c.customer_id, c.name FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE o.order_id = 101",
      concepts: ["join"],
      sourceRelations: ["customers", "orders"],
      constraints: [{
        kind: "query_structure",
        target: "query.has_join",
        operator: "equals",
        value: true,
      }],
    }),
    studentSql: "SELECT customer_id, name FROM customers WHERE customer_id = 1",
  });

  assert.equal(result.status, "constraint_violation");
});

test("PROPERTY_BASED valida propriedades sem reference query", async () => {
  const result = await validate({
    exerciseInput: exercise({ strategy: "PROPERTY_BASED" }),
    metadataInput: metadata({
      strategy: "PROPERTY_BASED",
      columns: ["customer_id", "name"],
      referenceQuery: null,
      rowCount: 4,
      constraints: [{
        kind: "result_property",
        target: "result.row_count",
        operator: "equals",
        value: 4,
      }],
    }),
    studentSql: "SELECT customer_id, name FROM customers",
  });

  assert.equal(result.status, "correct");
  assert.equal(result.expected_summary.reference_executed, false);
});

test("erro de sintaxe do aluno permanece execution_error", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers",
    }),
    studentSql: "SELEC customer_id, name FORM customers",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.execution.error.category, "syntax_error");
});

test("ação proibida permanece security_violation", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id", "name"],
      referenceQuery: "SELECT customer_id, name FROM customers",
    }),
    studentSql: "DELETE FROM customers",
  });

  assert.equal(result.status, "security_violation");
});

test("query longa permanece timeout", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["total"],
      referenceQuery: "SELECT count(*) AS total FROM customers",
    }),
    studentSql: "SELECT count(*) AS total FROM generate_series(1, 1000000000) AS generated_number",
  });

  assert.equal(result.status, "timeout");
});

test("reference query sintaticamente inválida não executa SQL do aluno", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id"],
      referenceQuery: "SELEC customer_id FORM customers",
    }),
    studentSql: "SELECT customer_id FROM customers",
  });

  assert.equal(result.status, "reference_validation_error");
  assert.equal(result.execution, null);
  assert.equal(result.mismatches[0].code, "reference_query_invalid");
});

test("erro PostgreSQL na reference query é problema interno do exercício", async () => {
  const result = await validate({
    metadataInput: metadata({
      columns: ["customer_id"],
      referenceQuery: "SELECT nonexistent_column AS customer_id FROM customers",
    }),
    studentSql: "SELECT customer_id FROM customers",
  });

  assert.equal(result.status, "reference_validation_error");
  assert.equal(result.mismatches[0].code, "reference_execution_error");
});

test("PLAN_CONSTRAINT usa plano real sem EXPLAIN ANALYZE", async () => {
  const referenceQuery = "SELECT customer_id, name FROM customers";
  const result = await validate({
    exerciseInput: exercise({ strategy: "PLAN_CONSTRAINT", concepts: ["explain"] }),
    metadataInput: metadata({
      strategy: "PLAN_CONSTRAINT",
      columns: ["customer_id", "name"],
      referenceQuery,
      concepts: ["explain"],
      constraints: [{
        kind: "plan_property",
        target: "plan.relation_names",
        operator: "contains",
        value: "customers",
      }],
    }),
    studentSql: referenceQuery,
  });

  assert.equal(result.status, "correct");
  assert.equal(result.plan_evidence.status, "ok");
  assert.equal(result.plan_evidence.analyze, false);
  assert.equal(result.plan_evidence.execution_time_ms, null);
});

test("resultado integrado não vaza reference query, segredo ou stack", async () => {
  const referenceQuery = "SELECT customer_id, name FROM customers WHERE customer_id = 1";
  const result = await validate({
    metadataInput: metadata({ columns: ["customer_id", "name"], referenceQuery }),
    studentSql: referenceQuery,
  });
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /SELECT customer_id|reference_query|password|postgres:\/\/|stack/iu);
});

