import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createSqlSandboxFromEnv } from "../../src/sandbox/sql-sandbox.js";

const sandbox = createSqlSandboxFromEnv({
  ...process.env,
  SQL_MENTOR_SANDBOX_TIMEOUT_MS: "50",
  SQL_MENTOR_SANDBOX_MAX_ROWS: "3",
});

after(async () => {
  await sandbox.close();
});

test("executa SELECT válido exclusivamente como mentor_sandbox", async () => {
  const result = await sandbox.execute(
    "SELECT current_user AS role, customer_id, name FROM customers WHERE customer_id = 1",
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(result.columns, ["role", "customer_id", "name"]);
  assert.equal(result.rows[0].role, "mentor_sandbox");
  assert.equal(result.rows[0].name, "Ana Souza");
  assert.equal(result.error, null);
});

test("executa SELECT com JOIN", async () => {
  const result = await sandbox.execute(`
    SELECT c.name AS customer_name, o.order_id
    FROM customers c
    JOIN orders o ON o.customer_id = c.customer_id
    WHERE o.order_id = 101
  `);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.rows, [{ customer_name: "Ana Souza", order_id: 101 }]);
});

test("executa CTE de leitura", async () => {
  const result = await sandbox.execute(`
    WITH completed AS (
      SELECT order_id FROM orders WHERE status = 'completed'
    )
    SELECT count(*)::integer AS total FROM completed
  `);

  assert.equal(result.status, "ok");
  assert.equal(result.rows[0].total, 2);
});

test("bloqueia acesso ao app_state", async () => {
  const result = await sandbox.execute("SELECT * FROM app_state.learning_sessions");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "security_violation");
  assert.doesNotMatch(result.error.message, /app_state|learning_sessions/u);
});

test("bloqueia DML", async (context) => {
  const attempts = {
    INSERT: "INSERT INTO customers (customer_id, name, city, created_at) VALUES (99, 'x', 'y', current_date)",
    UPDATE: "UPDATE customers SET name = 'x' WHERE customer_id = 1",
    DELETE: "DELETE FROM customers WHERE customer_id = 1",
  };

  for (const [name, sql] of Object.entries(attempts)) {
    await context.test(name, async () => {
      const result = await sandbox.execute(sql);
      assert.equal(result.status, "error");
      assert.equal(result.error.category, "security_violation");
    });
  }
});

test("bloqueia CREATE, DROP e ALTER", async (context) => {
  const attempts = {
    CREATE: "CREATE TABLE intruder (id integer)",
    DROP: "DROP TABLE customers",
    ALTER: "ALTER TABLE customers ADD COLUMN intruder integer",
  };

  for (const [name, sql] of Object.entries(attempts)) {
    await context.test(name, async () => {
      const result = await sandbox.execute(sql);
      assert.equal(result.status, "error");
      assert.equal(result.error.category, "security_violation");
    });
  }
});

test("bloqueia TRUNCATE, COPY, EXPLAIN e comando administrativo", async () => {
  const attempts = [
    "TRUNCATE customers",
    "COPY customers TO STDOUT",
    "EXPLAIN SELECT * FROM customers",
    "VACUUM customers",
  ];

  for (const sql of attempts) {
    const result = await sandbox.execute(sql);
    assert.equal(result.status, "error");
    assert.equal(result.error.category, "security_violation");
  }
});

test("bloqueia múltiplas statements", async () => {
  const result = await sandbox.execute("SELECT * FROM customers; DELETE FROM customers");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "security_violation");
});

test("bloqueia SET e tentativa de mudar transaction_read_only", async () => {
  const setResult = await sandbox.execute("SET statement_timeout = 0");
  const readOnlyResult = await sandbox.execute("SET transaction_read_only = off");
  const functionResult = await sandbox.execute(
    "SELECT set_config('transaction_read_only', 'off', false)",
  );

  assert.equal(setResult.error.category, "security_violation");
  assert.equal(readOnlyResult.error.category, "security_violation");
  assert.equal(functionResult.error.category, "security_violation");
});

test("diferencia syntax error", async () => {
  const result = await sandbox.execute("SELEC * FORM customers");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "syntax_error");
});

test("diferencia execution error sem expor detalhe interno", async () => {
  const result = await sandbox.execute("SELECT 1 / 0 AS failure");

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "execution_error");
  assert.doesNotMatch(result.error.message, /division|stack|postgres/iu);
});

test("interrompe query que excede statement_timeout", async () => {
  const result = await sandbox.execute(
    "SELECT count(*) AS total FROM generate_series(1, 1000000000) AS generated_number",
  );

  assert.equal(result.status, "error");
  assert.equal(result.error.category, "timeout");
});

test("limita e sinaliza resultado maior que o configurado", async () => {
  const result = await sandbox.execute(`
    SELECT c.customer_id, p.product_id
    FROM customers c
    CROSS JOIN products p
    ORDER BY c.customer_id, p.product_id
  `);

  assert.equal(result.status, "ok");
  assert.equal(result.rows.length, 3);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, true);
});

test("dataset permanece íntegro depois das tentativas maliciosas", async () => {
  const result = await sandbox.execute("SELECT name FROM customers WHERE customer_id = 1");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.rows, [{ name: "Ana Souza" }]);
});
