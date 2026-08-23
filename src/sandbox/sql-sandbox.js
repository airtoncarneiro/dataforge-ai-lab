import { performance } from "node:perf_hooks";

import pg from "pg";

import { ERROR_CATEGORIES, SqlPolicy, SqlPolicyError } from "./sql-policy.js";

const { Pool } = pg;

export const SANDBOX_ROLE = "mentor_sandbox";

function errorResult(category, message, sqlstate = null) {
  return {
    status: "error",
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    error: { category, sqlstate, message },
  };
}

function withDuration(result, startedAt, clock) {
  const elapsed = clock() - startedAt;
  const durationMs = Number.isFinite(elapsed)
    ? Math.max(0, Number(elapsed.toFixed(3)))
    : 0;

  return {
    status: result.status,
    columns: result.columns,
    rows: result.rows,
    row_count: result.row_count,
    truncated: result.truncated,
    duration_ms: durationMs,
    error: result.error,
  };
}

function parsePositiveInteger(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}

function mapError(error, timeoutMs) {
  if (error instanceof SqlPolicyError) {
    const sqlstate = error.category === ERROR_CATEGORIES.SYNTAX ? "42601" : null;
    return errorResult(error.category, error.message, sqlstate);
  }

  if (error?.code === "57014") {
    return errorResult(
      ERROR_CATEGORIES.TIMEOUT,
      `A consulta excedeu o tempo máximo de ${timeoutMs} ms.`,
      error.code,
    );
  }

  if (error?.code === "42501" || error?.code === "25006") {
    return errorResult(
      ERROR_CATEGORIES.SECURITY,
      "A consulta viola a política de segurança do sandbox.",
      error.code,
    );
  }

  if (error?.code === "42601") {
    return errorResult(
      ERROR_CATEGORIES.SYNTAX,
      "A consulta possui sintaxe SQL inválida.",
      error.code,
    );
  }

  const sqlstate = typeof error?.severity === "string"
    && typeof error?.code === "string"
    && /^[0-9A-Z]{5}$/u.test(error.code)
    ? error.code
    : null;
  return errorResult(
    ERROR_CATEGORIES.EXECUTION,
    "A consulta não pôde ser executada.",
    sqlstate,
  );
}

export class SqlSandbox {
  constructor({
    pool,
    policy = new SqlPolicy(),
    timeoutMs = 1_000,
    maxRows = 100,
    clock = () => performance.now(),
  }) {
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("SqlSandbox requer um pool PostgreSQL válido.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("timeoutMs deve ser um inteiro positivo.");
    }
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
      throw new Error("maxRows deve ser um inteiro positivo.");
    }
    if (typeof clock !== "function") {
      throw new Error("clock deve ser uma função.");
    }

    this.pool = pool;
    this.policy = policy;
    this.timeoutMs = timeoutMs;
    this.maxRows = maxRows;
    this.clock = clock;
  }

  async execute(sql) {
    const startedAt = this.clock();
    let approved;
    try {
      approved = this.policy.validate(sql);
    } catch (error) {
      return withDuration(mapError(error, this.timeoutMs), startedAt, this.clock);
    }

    let client;
    let transactionStarted = false;
    let destroyClient = false;
    let output;

    try {
      client = await this.pool.connect();

      const identity = await client.query("SELECT current_user AS role");
      if (identity.rows[0]?.role !== SANDBOX_ROLE) {
        destroyClient = true;
        throw new Error("Sandbox database role mismatch");
      }

      await client.query("BEGIN READ ONLY");
      transactionStarted = true;
      await client.query(`SET LOCAL statement_timeout = ${this.timeoutMs}`);
      await client.query("SET LOCAL search_path = pg_catalog, education");

      const limitedSql = `SELECT * FROM (${approved.sql}) AS sandbox_result LIMIT ${this.maxRows + 1}`;
      const result = await client.query(limitedSql);
      const truncated = result.rows.length > this.maxRows;
      const rows = truncated ? result.rows.slice(0, this.maxRows) : result.rows;

      output = {
        status: "ok",
        columns: result.fields.map((field) => field.name),
        rows,
        row_count: rows.length,
        truncated,
        error: null,
      };
    } catch (error) {
      output = mapError(error, this.timeoutMs);
    } finally {
      if (client && transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
          output = errorResult(ERROR_CATEGORIES.EXECUTION, "A consulta não pôde ser executada.");
        }
      }

      client?.release(destroyClient);
    }

    return withDuration(output, startedAt, this.clock);
  }

  async close() {
    await this.pool.end();
  }
}

export function createSqlSandboxFromEnv(env = process.env) {
  if (!env.SQL_MENTOR_SANDBOX_PASSWORD) {
    throw new Error("SQL_MENTOR_SANDBOX_PASSWORD é obrigatória.");
  }

  const timeoutMs = parsePositiveInteger(
    env.SQL_MENTOR_SANDBOX_TIMEOUT_MS,
    1_000,
    "SQL_MENTOR_SANDBOX_TIMEOUT_MS",
    { max: 30_000 },
  );
  const maxRows = parsePositiveInteger(
    env.SQL_MENTOR_SANDBOX_MAX_ROWS,
    100,
    "SQL_MENTOR_SANDBOX_MAX_ROWS",
    { max: 1_000 },
  );
  const port = parsePositiveInteger(
    env.SQL_MENTOR_POSTGRES_PORT,
    5_432,
    "SQL_MENTOR_POSTGRES_PORT",
    { max: 65_535 },
  );

  const pool = new Pool({
    host: env.SQL_MENTOR_POSTGRES_HOST || "127.0.0.1",
    port,
    database: env.SQL_MENTOR_POSTGRES_DB || "sql_mentor",
    user: SANDBOX_ROLE,
    password: env.SQL_MENTOR_SANDBOX_PASSWORD,
    application_name: "sql-mentor-ai-sandbox",
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000,
    max: 2,
  });

  return new SqlSandbox({ pool, timeoutMs, maxRows });
}
