import assert from "node:assert/strict";
import test from "node:test";

import { SqlSandbox } from "../../src/sandbox/sql-sandbox.js";

function fakePoolForRole(role, { studentError = null } = {}) {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "SELECT current_user AS role") {
        return { rows: [{ role }] };
      }
      if (sql.startsWith("SELECT * FROM")) {
        if (studentError) {
          throw studentError;
        }
        return {
          fields: [{ name: "value" }],
          rows: [{ value: 1 }],
        };
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
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

function clockFrom(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("verifica a role antes de executar SQL do aluno e destrói conexão incompatível", async () => {
  const fake = fakePoolForRole("mentor_admin");
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(10, 12.3456) });

  const result = await sandbox.execute("SELECT 1 AS value");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.equal(result.error.sqlstate, null);
  assert.equal(result.duration_ms, 2.346);
  assert.deepEqual(fake.queries, ["SELECT current_user AS role"]);
  assert.deepEqual(fake.releases, [true]);
  assert.doesNotMatch(result.error.message, /role|mentor_admin/u);
});

test("usa transação read-only, limites locais e rollback", async () => {
  const fake = fakePoolForRole("mentor_sandbox");
  const sandbox = new SqlSandbox({
    pool: fake.pool,
    timeoutMs: 250,
    maxRows: 5,
    clock: clockFrom(100, 112.5),
  });

  const result = await sandbox.execute("SELECT 1 AS value");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.rows, [{ value: 1 }]);
  assert.equal(result.row_count, 1);
  assert.equal(result.duration_ms, 12.5);
  assert.deepEqual(fake.queries, [
    "SELECT current_user AS role",
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 250",
    "SET LOCAL search_path = pg_catalog, education",
    "SELECT * FROM (SELECT (1) AS value) AS sandbox_result LIMIT 6",
    "ROLLBACK",
  ]);
  assert.equal(fake.queries.filter((sql) => sql.includes("sandbox_result")).length, 1);
  assert.deepEqual(fake.releases, [false]);
});

test("preserva SQLSTATE e remove detalhes internos do erro PostgreSQL", async () => {
  const databaseError = Object.assign(new Error("division by zero at internal host"), {
    code: "22012",
    severity: "ERROR",
    detail: "password=should-never-leak",
    connectionString: "postgres://mentor_admin:secret@internal/sql_mentor",
  });
  const fake = fakePoolForRole("mentor_sandbox", { studentError: databaseError });
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(20, 24) });

  const result = await sandbox.execute("SELECT 1 AS value");
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.equal(result.error.sqlstate, "22012");
  assert.equal(result.duration_ms, 4);
  assert.doesNotMatch(serialized, /division|password|secret|internal|postgres:\/\//iu);
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.deepEqual(fake.releases, [false]);
});

test("não confunde código interno com SQLSTATE PostgreSQL", async () => {
  const systemError = Object.assign(new Error("internal transport failure"), {
    code: "EPIPE",
  });
  const fake = fakePoolForRole("mentor_sandbox", { studentError: systemError });
  const sandbox = new SqlSandbox({ pool: fake.pool, clock: clockFrom(30, 31) });

  const result = await sandbox.execute("SELECT 1 AS value");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.equal(result.error.sqlstate, null);
  assert.doesNotMatch(JSON.stringify(result), /EPIPE|transport|internal/u);
});
