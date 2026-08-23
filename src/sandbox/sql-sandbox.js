import pg from "pg";

import { ERROR_CATEGORIES, SqlPolicy, SqlPolicyError } from "./sql-policy.js";

const { Pool } = pg;

export const SANDBOX_ROLE = "mentor_sandbox";

function errorResult(category, message) {
  return {
    status: "error",
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    error: { category, message },
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
    return errorResult(error.category, error.message);
  }

  if (error?.code === "57014") {
    return errorResult(ERROR_CATEGORIES.TIMEOUT, `A consulta excedeu o tempo máximo de ${timeoutMs} ms.`);
  }

  if (error?.code === "42501" || error?.code === "25006") {
    return errorResult(
      ERROR_CATEGORIES.SECURITY,
      "A consulta viola a política de segurança do sandbox.",
    );
  }

  if (error?.code === "42601") {
    return errorResult(ERROR_CATEGORIES.SYNTAX, "A consulta possui sintaxe SQL inválida.");
  }

  return errorResult(ERROR_CATEGORIES.EXECUTION, "A consulta não pôde ser executada.");
}

export class SqlSandbox {
  constructor({ pool, policy = new SqlPolicy(), timeoutMs = 1_000, maxRows = 100 }) {
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("SqlSandbox requer um pool PostgreSQL válido.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("timeoutMs deve ser um inteiro positivo.");
    }
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
      throw new Error("maxRows deve ser um inteiro positivo.");
    }

    this.pool = pool;
    this.policy = policy;
    this.timeoutMs = timeoutMs;
    this.maxRows = maxRows;
  }

  async execute(sql) {
    let approved;
    try {
      approved = this.policy.validate(sql);
    } catch (error) {
      return mapError(error, this.timeoutMs);
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
        rowCount: rows.length,
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

    return output;
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
