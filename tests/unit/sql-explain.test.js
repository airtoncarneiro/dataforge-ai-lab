import assert from "node:assert/strict";
import test from "node:test";

import { SqlSandbox } from "../../src/sandbox/sql-sandbox.js";

const EXPLAIN_DOCUMENT = [{
  Plan: {
    "Node Type": "Nested Loop",
    "Startup Cost": 0.3,
    "Total Cost": 20.4,
    "Plan Rows": 2,
    "Plan Width": 32,
    Plans: [
      {
        "Node Type": "Index Scan",
        "Relation Name": "customers",
        "Index Name": "customers_pkey",
        "Startup Cost": 0.15,
        "Total Cost": 8.17,
        "Plan Rows": 1,
        "Plan Width": 16,
      },
      {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        "Startup Cost": 0,
        "Total Cost": 12.2,
        "Plan Rows": 2,
        "Plan Width": 16,
        "Subplan Name": "educational_subplan",
      },
    ],
  },
  "Planning Time": 0.321,
}];

function clockFrom(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function fakeExplainPool({ explainError = null, payload = EXPLAIN_DOCUMENT } = {}) {
  const queries = [];
  const releases = [];
  let connections = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "SELECT current_user AS role") {
        return { rows: [{ role: "mentor_sandbox" }] };
      }
      if (sql.startsWith("EXPLAIN")) {
        if (explainError) {
          throw explainError;
        }
        return { rows: [{ "QUERY PLAN": payload }] };
      }
      return { fields: [], rows: [] };
    },
    release(destroy) {
      releases.push(Boolean(destroy));
    },
  };

  return {
    queries,
    releases,
    get connections() {
      return connections;
    },
    pool: {
      async connect() {
        connections += 1;
        return client;
      },
      async end() {},
    },
  };
}

test("constrói EXPLAIN JSON no backend e normaliza o plano recursivamente", async () => {
  const fake = fakeExplainPool();
  const sandbox = new SqlSandbox({
    pool: fake.pool,
    timeoutMs: 250,
    clock: clockFrom(10, 13.4567),
  });

  const result = await sandbox.explain(`
    SELECT c.name, o.order_id
    FROM customers c
    JOIN orders o ON o.customer_id = c.customer_id
  `);

  assert.deepEqual(result, {
    status: "ok",
    analyze: false,
    plan: {
      node_type: "Nested Loop",
      relation_name: null,
      index_name: null,
      startup_cost: 0.3,
      total_cost: 20.4,
      plan_rows: 2,
      plan_width: 32,
      subplan_name: null,
      plans: [
        {
          node_type: "Index Scan",
          relation_name: "customers",
          index_name: "customers_pkey",
          startup_cost: 0.15,
          total_cost: 8.17,
          plan_rows: 1,
          plan_width: 16,
          subplan_name: null,
          plans: [],
        },
        {
          node_type: "Seq Scan",
          relation_name: "orders",
          index_name: null,
          startup_cost: 0,
          total_cost: 12.2,
          plan_rows: 2,
          plan_width: 16,
          subplan_name: "educational_subplan",
          plans: [],
        },
      ],
    },
    planning_time_ms: 0.321,
    execution_time_ms: null,
    duration_ms: 3.457,
    error: null,
  });
  assert.deepEqual(fake.queries.slice(0, 4), [
    "SELECT current_user AS role",
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 250",
    "SET LOCAL search_path = pg_catalog, education",
  ]);
  assert.match(fake.queries[4], /^EXPLAIN \(FORMAT JSON, ANALYZE FALSE\) SELECT/iu);
  assert.equal(fake.queries.filter((sql) => sql.startsWith("EXPLAIN")).length, 1);
  assert.equal(fake.queries.filter((sql) => sql.includes("FROM customers")).length, 1);
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.deepEqual(fake.releases, [false]);
});

test("não permite EXPLAIN enviado pelo aluno nem abre conexão", async () => {
  const fake = fakeExplainPool();
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(20, 21) });

  const result = await sandbox.explain("EXPLAIN SELECT * FROM customers");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "security_violation");
  assert.equal(result.plan, null);
  assert.equal(result.execution_time_ms, null);
  assert.equal(fake.connections, 0);
  assert.deepEqual(fake.queries, []);
});

test("mantém EXPLAIN ANALYZE como operação distinta e desabilitada", async () => {
  const fake = fakeExplainPool();
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(30, 30.5) });

  const result = await sandbox.explain("SELECT * FROM customers", { analyze: true });

  assert.deepEqual(result, {
    status: "error",
    analyze: false,
    plan: null,
    planning_time_ms: null,
    execution_time_ms: null,
    duration_ms: 0.5,
    error: {
      category: "security_violation",
      sqlstate: null,
      message: "EXPLAIN ANALYZE não está habilitado no sandbox.",
    },
  });
  assert.equal(fake.connections, 0);
  assert.deepEqual(fake.queries, []);
});

test("sanitiza erros PostgreSQL durante EXPLAIN e preserva rollback", async () => {
  const databaseError = Object.assign(new Error("internal planner failure"), {
    code: "XX000",
    severity: "ERROR",
    detail: "password=should-never-leak",
    connectionString: "postgres://mentor_admin:secret@internal/sql_mentor",
    stack: "sensitive stack trace",
  });
  const fake = fakeExplainPool({ explainError: databaseError });
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(40, 42) });

  const result = await sandbox.explain("SELECT * FROM customers");
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.equal(result.error.sqlstate, "XX000");
  assert.equal(result.plan, null);
  assert.equal(result.execution_time_ms, null);
  assert.doesNotMatch(serialized, /planner|password|secret|internal|stack|postgres:\/\//iu);
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.deepEqual(fake.releases, [false]);
});
