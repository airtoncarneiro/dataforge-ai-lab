import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function composeExec(command) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "postgres", "sh", "-c", command], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

function adminQuery(sql) {
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  return composeExec(
    `exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc ${JSON.stringify(normalizedSql)}`,
  );
}

function sandboxQuery(sql) {
  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  return composeExec(
    `PGPASSWORD="$SQL_MENTOR_SANDBOX_PASSWORD" exec psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U mentor_sandbox -d "$POSTGRES_DB" -Atc ${JSON.stringify(normalizedSql)}`,
  );
}

test("carrega todas as entidades educacionais", () => {
  const result = adminQuery(`
    SELECT
      (SELECT count(*) FROM education.customers),
      (SELECT count(*) FROM education.orders),
      (SELECT count(*) FROM education.order_items),
      (SELECT count(*) FROM education.products),
      (SELECT count(*) FROM education.categories),
      (SELECT count(*) FROM education.employees),
      (SELECT count(*) FROM education.departments)
  `);

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "4|4|6|5|3|4|3");
});

test("cria a estrutura relacional e suas restricoes de integridade", () => {
  const result = adminQuery(`
    SELECT
      (SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'education'
          AND table_name IN (
            'customers', 'orders', 'order_items', 'products',
            'categories', 'employees', 'departments'
          )),
      (SELECT count(*) FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'education' AND c.contype = 'p'),
      (SELECT count(*) FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'education' AND c.contype = 'f'),
      (SELECT count(*) FROM education.orders o
        LEFT JOIN education.customers c ON c.customer_id = o.customer_id
        WHERE c.customer_id IS NULL),
      (SELECT count(*) FROM education.order_items i
        LEFT JOIN education.orders o ON o.order_id = i.order_id
        LEFT JOIN education.products p ON p.product_id = i.product_id
        WHERE o.order_id IS NULL OR p.product_id IS NULL)
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "7|7|7|0|0");
});

test("dataset inclui os edge cases definidos em B03", () => {
  const result = adminQuery(`
    SELECT
      (SELECT count(*) FROM education.customers WHERE email IS NULL),
      (SELECT count(*) FROM education.customers c WHERE NOT EXISTS (
        SELECT 1 FROM education.orders o WHERE o.customer_id = c.customer_id
      )),
      (SELECT count(*) FROM education.products p WHERE NOT EXISTS (
        SELECT 1 FROM education.order_items i WHERE i.product_id = p.product_id
      )),
      (SELECT count(*) FROM education.employees WHERE department_id IS NULL),
      (SELECT count(*) FROM (
        SELECT customer_id FROM education.orders GROUP BY customer_id HAVING count(*) > 1
      ) customers_with_multiple_orders),
      (SELECT count(DISTINCT ordered_at::date) FROM education.orders)
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1|1|2|1|1|4");
});

test("role de sandbox consegue ler o dataset", () => {
  const result = sandboxQuery("SELECT count(*) FROM education.customers");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "4");
});

test("role de sandbox possui menor privilegio e limites padrao", () => {
  const attributes = adminQuery(`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = 'mentor_sandbox'
  `);
  const defaults = sandboxQuery(
    "SELECT current_setting('transaction_read_only'), current_setting('statement_timeout')",
  );

  assert.equal(attributes.status, 0, attributes.stderr);
  assert.equal(attributes.stdout, "f|f|f|f|f|f");
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(defaults.stdout, "on|3s");
});

test("role de sandbox nao consegue alterar o dataset", () => {
  const result = sandboxQuery(
    "SET transaction_read_only = off; UPDATE education.customers SET name = 'invasor' WHERE customer_id = 1",
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permission denied/i);

  const verification = adminQuery("SELECT name FROM education.customers WHERE customer_id = 1");
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(verification.stdout, "Ana Souza");
});

test("role de sandbox nao acessa o estado da aplicacao", () => {
  const result = sandboxQuery("SELECT count(*) FROM app_state.learning_sessions");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permission denied/i);
});

test("bootstrap existe uma unica vez no estado interno", () => {
  const result = adminQuery(`
    SELECT count(*)
    FROM app_state.learning_sessions
    WHERE learner_goal = 'bootstrap verification' AND current_phase = 'FOUNDATION'
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1");
});
