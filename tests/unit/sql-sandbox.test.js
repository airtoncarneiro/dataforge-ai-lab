import assert from "node:assert/strict";
import test from "node:test";

import { SqlSandbox } from "../../src/sandbox/sql-sandbox.js";

function fakePoolForRole(role) {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "SELECT current_user AS role") {
        return { rows: [{ role }] };
      }
      if (sql.startsWith("SELECT * FROM")) {
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

test("verifica a role antes de executar SQL do aluno e destrói conexão incompatível", async () => {
  const fake = fakePoolForRole("mentor_admin");
  const sandbox = new SqlSandbox({ pool: fake.pool });

  const result = await sandbox.execute("SELECT 1 AS value");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.deepEqual(fake.queries, ["SELECT current_user AS role"]);
  assert.deepEqual(fake.releases, [true]);
  assert.doesNotMatch(result.error.message, /role|mentor_admin/u);
});

test("usa transação read-only, limites locais e rollback", async () => {
  const fake = fakePoolForRole("mentor_sandbox");
  const sandbox = new SqlSandbox({ pool: fake.pool, timeoutMs: 250, maxRows: 5 });

  const result = await sandbox.execute("SELECT 1 AS value");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.rows, [{ value: 1 }]);
  assert.deepEqual(fake.queries, [
    "SELECT current_user AS role",
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 250",
    "SET LOCAL search_path = pg_catalog, education",
    "SELECT * FROM (SELECT (1) AS value) AS sandbox_result LIMIT 6",
    "ROLLBACK",
  ]);
  assert.deepEqual(fake.releases, [false]);
});

