import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CATEGORIES, SqlPolicy, SqlPolicyError } from "../../src/sandbox/sql-policy.js";

const policy = new SqlPolicy();

function assertRejected(sql, category = ERROR_CATEGORIES.SECURITY) {
  assert.throws(
    () => policy.validate(sql),
    (error) => error instanceof SqlPolicyError && error.category === category,
  );
}

test("aceita SELECT, JOIN, subquery e CTE de leitura", () => {
  const queries = [
    "SELECT customer_id, name FROM customers ORDER BY customer_id",
    "SELECT c.name, o.order_id FROM customers c JOIN orders o ON o.customer_id = c.customer_id",
    "SELECT customer_id, (SELECT count(*) FROM orders) AS total FROM customers",
    "SELECT * FROM (SELECT customer_id FROM customers) AS selected_customers",
    "WITH recent AS (SELECT * FROM orders WHERE ordered_at >= DATE '2025-01-01') SELECT * FROM recent",
    "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 3) SELECT * FROM nums",
  ];

  for (const sql of queries) {
    const approved = policy.validate(sql);
    assert.equal(typeof approved.sql, "string");
    assert.ok(approved.sql.length > 0);
  }
});

test("serializa novamente a statement aprovada sem comentários ou delimitador", () => {
  const approved = policy.validate("SELECT * FROM customers; -- comentário permitido");

  assert.doesNotMatch(approved.sql, /comentário|;/u);
});

test("diferencia erro de sintaxe", () => {
  assertRejected("SELEC * FORM customers", ERROR_CATEGORIES.SYNTAX);
});

test("bloqueia múltiplas statements inclusive com comentários", () => {
  assertRejected("SELECT * FROM customers; DELETE FROM customers");
  assertRejected("SELECT * FROM customers; /* disfarce */ DROP TABLE customers");
});

test("bloqueia DML e DDL", () => {
  const queries = [
    "INSERT INTO customers (customer_id, name, city, created_at) VALUES (99, 'x', 'y', current_date)",
    "UPDATE customers SET name = 'x'",
    "DELETE FROM customers",
    "TRUNCATE customers",
    "CREATE TABLE intruder (id integer)",
    "SELECT * INTO copied_customers FROM customers",
    "DROP TABLE customers",
    "ALTER TABLE customers ADD COLUMN intruder integer",
  ];

  for (const sql of queries) {
    assertRejected(sql);
  }
});

test("bloqueia DML escondido em CTE", () => {
  assertRejected("WITH removed AS (DELETE FROM customers RETURNING *) SELECT * FROM removed");
});

test("bloqueia SET, mudança de read-only e locking SELECT", () => {
  assertRejected("SET statement_timeout = 0");
  assertRejected("SET transaction_read_only = off");
  assertRejected("SELECT * FROM customers FOR UPDATE");
});

test("bloqueia COPY, EXPLAIN e comandos administrativos", () => {
  const queries = [
    "COPY customers TO STDOUT",
    "EXPLAIN SELECT * FROM customers",
    "VACUUM customers",
    "SHOW search_path",
  ];

  for (const sql of queries) {
    assertRejected(sql);
  }
});

test("bloqueia schemas, relações e funções fora das allowlists", () => {
  const queries = [
    "SELECT * FROM app_state.learning_sessions",
    "SELECT * FROM pg_catalog.pg_class",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM pg_class",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT set_config('transaction_read_only', 'off', false)",
  ];

  for (const sql of queries) {
    assertRejected(sql);
  }
});

test("não confunde CTE com relação de mesmo nome fora do seu escopo", () => {
  assertRejected("WITH pg_class AS (SELECT * FROM pg_class) SELECT * FROM pg_class");
});
