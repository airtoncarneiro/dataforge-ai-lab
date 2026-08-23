import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createSqlSandboxFromEnv } from "../../src/sandbox/sql-sandbox.js";

const sandbox = createSqlSandboxFromEnv({
  ...process.env,
  SQL_MENTOR_SANDBOX_TIMEOUT_MS: "100",
  SQL_MENTOR_SANDBOX_MAX_ROWS: "3",
});
const timeoutSandbox = createSqlSandboxFromEnv({
  ...process.env,
  SQL_MENTOR_SANDBOX_TIMEOUT_MS: "1",
  SQL_MENTOR_SANDBOX_MAX_ROWS: "3",
});

const EXPLAIN_FIELDS = [
  "status",
  "analyze",
  "plan",
  "planning_time_ms",
  "execution_time_ms",
  "duration_ms",
  "error",
];
const PLAN_NODE_FIELDS = [
  "node_type",
  "relation_name",
  "index_name",
  "startup_cost",
  "total_cost",
  "plan_rows",
  "plan_width",
  "subplan_name",
  "plans",
];

function flattenPlan(node) {
  return [node, ...node.plans.flatMap(flattenPlan)];
}

function assertPlanNode(node) {
  assert.deepEqual(Object.keys(node), PLAN_NODE_FIELDS);
  assert.equal(typeof node.node_type, "string");
  assert.equal(typeof node.startup_cost, "number");
  assert.equal(typeof node.total_cost, "number");
  assert.equal(typeof node.plan_rows, "number");
  assert.equal(typeof node.plan_width, "number");
  assert.ok(Array.isArray(node.plans));
  for (const child of node.plans) {
    assertPlanNode(child);
  }
}

function assertExplainResult(result) {
  assert.deepEqual(Object.keys(result), EXPLAIN_FIELDS);
  assert.equal(result.analyze, false);
  assert.equal(result.execution_time_ms, null);
  assert.equal(typeof result.duration_ms, "number");
  assert.ok(Number.isFinite(result.duration_ms));
  assert.ok(result.duration_ms >= 0);
  if (result.status === "ok") {
    assertPlanNode(result.plan);
    assert.ok(result.planning_time_ms === null || typeof result.planning_time_ms === "number");
    assert.equal(result.error, null);
  } else {
    assert.equal(result.plan, null);
    assert.equal(result.planning_time_ms, null);
  }
}

function assertSecurityViolation(result) {
  assertExplainResult(result);
  assert.equal(result.status, "error");
  assert.equal(result.error.category, "security_violation");
  assert.equal(result.error.sqlstate, null);
}

after(async () => {
  await Promise.all([sandbox.close(), timeoutSandbox.close()]);
});

test("gera plano estruturado para SELECT simples sem executar ANALYZE", async () => {
  const result = await sandbox.explain(
    "SELECT customer_id, name FROM customers WHERE customer_id = 1",
  );

  assertExplainResult(result);
  assert.equal(result.status, "ok");
  assert.ok(flattenPlan(result.plan).some((node) => node.relation_name === "customers"));
});

test("preserva filhos do plano de um JOIN", async () => {
  const result = await sandbox.explain(`
    SELECT c.name, o.order_id
    FROM customers c
    JOIN orders o ON o.customer_id = c.customer_id
  `);

  assertExplainResult(result);
  assert.equal(result.status, "ok");
  const nodes = flattenPlan(result.plan);
  assert.ok(nodes.some((node) => node.relation_name === "customers"));
  assert.ok(nodes.some((node) => node.relation_name === "orders"));
  assert.ok(result.plan.plans.length > 0);
});

test("representa agregação no plano", async () => {
  const result = await sandbox.explain(`
    SELECT customer_id, count(*) AS order_count
    FROM orders
    GROUP BY customer_id
  `);

  assertExplainResult(result);
  assert.equal(result.status, "ok");
  assert.ok(flattenPlan(result.plan).some((node) => node.node_type.includes("Aggregate")));
});

test("gera plano para CTE e subquery de leitura", async () => {
  const result = await sandbox.explain(`
    WITH recent_orders AS (
      SELECT order_id, customer_id FROM orders WHERE ordered_at >= DATE '2024-01-01'
    )
    SELECT c.name
    FROM customers c
    WHERE c.customer_id IN (SELECT customer_id FROM recent_orders)
  `);

  assertExplainResult(result);
  assert.equal(result.status, "ok");
  const nodes = flattenPlan(result.plan);
  assert.ok(nodes.some((node) => node.relation_name === "customers"));
  assert.ok(nodes.some((node) => node.relation_name === "orders"));
});

test("informa o índice escolhido pelo PostgreSQL quando aplicável", async () => {
  const result = await sandbox.explain(
    "SELECT customer_id FROM customers ORDER BY customer_id LIMIT 1",
  );

  assertExplainResult(result);
  assert.equal(result.status, "ok");
  assert.ok(flattenPlan(result.plan).some((node) => node.index_name === "customers_pkey"));
});

test("rejeita DML, DDL, múltiplas statements e app_state pela política compartilhada", async (context) => {
  const attempts = {
    DML: "DELETE FROM customers WHERE customer_id = 1",
    DDL: "DROP TABLE customers",
    MULTIPLE: "SELECT * FROM customers; SELECT * FROM orders",
    APP_STATE: "SELECT * FROM app_state.learning_sessions",
  };

  for (const [name, sql] of Object.entries(attempts)) {
    await context.test(name, async () => {
      assertSecurityViolation(await sandbox.explain(sql));
    });
  }
});

test("rejeita EXPLAIN direto e EXPLAIN ANALYZE sem acessar o plano", async () => {
  const direct = await sandbox.explain("EXPLAIN SELECT * FROM customers");
  const analyze = await sandbox.explain("SELECT * FROM customers", { analyze: true });

  assertSecurityViolation(direct);
  assertSecurityViolation(analyze);
  assert.match(analyze.error.message, /ANALYZE/u);
});

test("classifica SQL inválida sem expor detalhes internos", async () => {
  const result = await sandbox.explain("SELEC * FORM customers");

  assertExplainResult(result);
  assert.equal(result.status, "error");
  assert.equal(result.error.category, "syntax_error");
  assert.equal(result.error.sqlstate, "42601");
  assert.doesNotMatch(JSON.stringify(result), /stack|connectionstring|postgres:\/\/|password/iu);
});

test("aplica statement_timeout também ao planejamento", async () => {
  const aliases = Array.from({ length: 24 }, (_, index) => `customers c${index + 1}`);
  const result = await timeoutSandbox.explain(`SELECT 1 FROM ${aliases.join(" CROSS JOIN ")}`);

  assertExplainResult(result);
  assert.equal(result.status, "error");
  assert.equal(result.error.category, "timeout");
  assert.equal(result.error.sqlstate, "57014");
});

test("não inclui credenciais, conexão ou stack trace em falhas", async () => {
  const securityResult = await sandbox.explain("SELECT * FROM app_state.learning_sessions");
  const syntaxResult = await sandbox.explain("SELECT FROM");
  const serialized = JSON.stringify([securityResult, syntaxResult]);
  const sandboxPassword = process.env.SQL_MENTOR_SANDBOX_PASSWORD;

  assert.doesNotMatch(serialized, /stack|connectionstring|postgres:\/\//iu);
  if (sandboxPassword) {
    assert.ok(!serialized.includes(sandboxPassword));
  }
});
