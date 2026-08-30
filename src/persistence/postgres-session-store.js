import { readFile } from "node:fs/promises";

import pg from "pg";

import {
  CorruptSessionSnapshotError,
  IdempotencyConflictError,
  PersistenceError,
  SessionNotFoundError,
  assertSessionSnapshot,
  cloneSnapshot,
  sameJson,
} from "./contracts.js";

const { Pool } = pg;
const MIGRATION_URL = new URL("../../docker/postgres/init/020_b19_persistence.sql", import.meta.url);

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersistenceError("missing_configuration", `${name} é obrigatório para a persistência.`);
  }
  return value.trim();
}

function integer(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new PersistenceError("invalid_configuration", `${name} deve ser uma porta válida.`);
  }
  return parsed;
}

function json(value) {
  return JSON.stringify(value);
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A falha original continua sendo a evidência relevante para o chamador.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function immutableInsert(client, {
  table,
  idColumn,
  id,
  sessionId,
  payload,
  columns,
  values,
  entity,
  unique,
}) {
  const found = await client.query(
    `SELECT payload FROM app_state.${table} WHERE ${idColumn} = $1 FOR UPDATE`,
    [id],
  );
  if (found.rowCount > 0) {
    if (!sameJson(found.rows[0].payload, payload)) {
      throw new IdempotencyConflictError(entity, id);
    }
    return;
  }
  if (unique) {
    const conflicting = await client.query(
      `SELECT ${idColumn} FROM app_state.${table} WHERE ${unique.column} = $1 FOR UPDATE`,
      [unique.value],
    );
    if (conflicting.rowCount > 0) {
      throw new IdempotencyConflictError(entity, unique.value);
    }
  }
  const names = [idColumn, "session_id", ...columns, "payload"];
  const params = [id, sessionId, ...values, json(payload)];
  const placeholders = params.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(
    `INSERT INTO app_state.${table} (${names.join(", ")}) VALUES (${placeholders})`,
    params,
  );
}

export class PostgresSessionStore {
  #pool;

  constructor({ pool }) {
    if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
      throw new TypeError("PostgresSessionStore requer um pool PostgreSQL administrativo.");
    }
    this.#pool = pool;
  }

  async migrate() {
    const sql = (await readFile(MIGRATION_URL, "utf8"))
      .replace(/^\\set[^\n]*\n/u, "");
    await this.#pool.query(sql);
  }

  async close() {
    await this.#pool.end();
  }

  async createSession(sessionInput) {
    const session = assertSessionSnapshot(sessionInput);
    return withTransaction(this.#pool, async (client) => {
      const existing = await client.query(
        "SELECT payload FROM app_state.tutor_session_snapshots WHERE session_id = $1 FOR UPDATE",
        [session.id],
      );
      if (existing.rowCount > 0) {
        if (!sameJson(existing.rows[0].payload, session)) {
          throw new IdempotencyConflictError("LearningSession", session.id);
        }
        return cloneSnapshot(existing.rows[0].payload);
      }
      await client.query(
        `INSERT INTO app_state.tutor_learning_sessions
          (session_id, learning_goal, status, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          session.id,
          session.learning_goal,
          session.status,
          session.policy_version,
          session.created_at,
          session.updated_at,
        ],
      );
      await this.#writeSnapshot(client, session);
      return cloneSnapshot(session);
    });
  }

  async getSession(sessionId) {
    return this.loadSessionSnapshot(sessionId);
  }

  async saveSessionSnapshot(sessionInput) {
    const session = assertSessionSnapshot(sessionInput);
    return withTransaction(this.#pool, async (client) => {
      const exists = await client.query(
        "SELECT session_id FROM app_state.tutor_learning_sessions WHERE session_id = $1 FOR UPDATE",
        [session.id],
      );
      if (exists.rowCount === 0) throw new SessionNotFoundError(session.id);
      await client.query(
        `UPDATE app_state.tutor_learning_sessions
         SET learning_goal = $2, status = $3, policy_version = $4, updated_at = $5
         WHERE session_id = $1`,
        [session.id, session.learning_goal, session.status, session.policy_version, session.updated_at],
      );
      await this.#writeSnapshot(client, session);
      return cloneSnapshot(session);
    });
  }

  async loadSessionSnapshot(sessionId) {
    const result = await this.#pool.query(
      "SELECT payload FROM app_state.tutor_session_snapshots WHERE session_id = $1",
      [sessionId],
    );
    if (result.rowCount === 0) throw new SessionNotFoundError(sessionId);
    let session;
    try {
      session = assertSessionSnapshot(result.rows[0].payload);
      if (session.id !== sessionId) throw new CorruptSessionSnapshotError(sessionId);
      await this.#assertNormalizedRows(session);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new CorruptSessionSnapshotError(sessionId);
    }
    return cloneSnapshot(session);
  }

  async loadLatestSessionSnapshot() {
    const result = await this.#pool.query(
      `SELECT s.payload
         FROM app_state.tutor_session_snapshots s
         JOIN app_state.tutor_learning_sessions l ON l.session_id = s.session_id
        ORDER BY l.updated_at DESC
        LIMIT 1`,
    );
    if (result.rowCount === 0) throw new SessionNotFoundError("latest");
    try {
      const session = assertSessionSnapshot(result.rows[0].payload);
      await this.#assertNormalizedRows(session);
      return cloneSnapshot(session);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new CorruptSessionSnapshotError("latest");
    }
  }

  async saveLearnerState(sessionId, learnerState) {
    return this.#patchSnapshot(sessionId, { learner_state: learnerState });
  }

  async saveProbeSession(sessionId, probeSession) {
    return this.#patchSnapshot(sessionId, { probe_session: probeSession });
  }

  async saveFlowState(sessionId, flowState) {
    return this.#patchSnapshot(sessionId, { flow_state: flowState });
  }

  async saveExercise(sessionId, currentExercise) {
    return this.#patchSnapshot(sessionId, { current_exercise: currentExercise });
  }

  async saveAttempt(sessionId, attempt) {
    const current = await this.loadSessionSnapshot(sessionId);
    const existing = current.attempts.find((item) => item.id === attempt.id);
    if (existing) {
      if (!sameJson(existing, attempt)) throw new IdempotencyConflictError("Attempt", attempt.id);
      return current;
    }
    return this.#patchSnapshot(sessionId, { attempts: [...current.attempts, attempt] });
  }

  async saveEvaluation(sessionId, evaluatorResult) {
    const current = await this.loadSessionSnapshot(sessionId);
    const existing = current.evaluations.find(
      (item) => item.evaluation.id === evaluatorResult.evaluation.id,
    );
    if (existing) {
      if (!sameJson(existing, evaluatorResult)) {
        throw new IdempotencyConflictError("Evaluation", evaluatorResult.evaluation.id);
      }
      return current;
    }
    return this.#patchSnapshot(sessionId, { evaluations: [...current.evaluations, evaluatorResult] });
  }

  async saveMasteryChanges(sessionId, changes) {
    const current = await this.loadSessionSnapshot(sessionId);
    const merged = new Map(current.mastery_changes.map((item) => [item.id, item]));
    for (const change of changes) {
      const existing = merged.get(change.id);
      if (existing && !sameJson(existing, change)) {
        throw new IdempotencyConflictError("MasteryChange", change.id);
      }
      merged.set(change.id, change);
    }
    return this.#patchSnapshot(sessionId, { mastery_changes: [...merged.values()] });
  }

  async saveDecision(sessionId, decision) {
    return this.#patchSnapshot(sessionId, { last_decision: decision });
  }

  async #patchSnapshot(sessionId, patch) {
    const current = await this.loadSessionSnapshot(sessionId);
    return this.saveSessionSnapshot({ ...current, ...patch });
  }

  async #writeSnapshot(client, session) {
    await client.query(
      `INSERT INTO app_state.tutor_flow_states (session_id, payload, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [session.id, json(session.flow_state), session.flow_state.updated_at],
    );
    if (session.learner_state !== null) {
      await client.query(
        `INSERT INTO app_state.tutor_learner_states (session_id, learner_state_id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (session_id) DO UPDATE SET learner_state_id = EXCLUDED.learner_state_id, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [session.id, session.learner_state.id, json(session.learner_state), session.learner_state.updated_at],
      );
    }
    if (session.probe_session !== null) {
      await client.query(
        `INSERT INTO app_state.tutor_probe_sessions (session_id, probe_session_id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (session_id) DO UPDATE SET probe_session_id = EXCLUDED.probe_session_id, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [session.id, session.probe_session.id, json(session.probe_session), session.probe_session.updated_at],
      );
    }
    if (session.current_exercise !== null) {
      await client.query(
        `INSERT INTO app_state.tutor_current_exercises (session_id, exercise_id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (session_id) DO UPDATE SET exercise_id = EXCLUDED.exercise_id, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        [session.id, session.current_exercise.exercise.id, json(session.current_exercise), session.updated_at],
      );
    } else {
      await client.query("DELETE FROM app_state.tutor_current_exercises WHERE session_id = $1", [session.id]);
    }
    for (const attempt of session.attempts) {
      await immutableInsert(client, {
        table: "tutor_attempts",
        idColumn: "attempt_id",
        id: attempt.id,
        sessionId: session.id,
        payload: attempt,
        columns: ["exercise_id", "submitted_at"],
        values: [attempt.exercise_id, attempt.submitted_at],
        entity: "Attempt",
      });
    }
    for (const evaluatorResult of session.evaluations) {
      const evaluation = evaluatorResult.evaluation;
      await immutableInsert(client, {
        table: "tutor_evaluations",
        idColumn: "evaluation_id",
        id: evaluation.id,
        sessionId: session.id,
        payload: evaluatorResult,
        columns: ["attempt_id", "evaluated_at"],
        values: [evaluation.attempt_id, evaluation.evaluated_at],
        entity: "Evaluation",
        unique: { column: "attempt_id", value: evaluation.attempt_id },
      });
    }
    for (const change of session.mastery_changes) {
      await immutableInsert(client, {
        table: "tutor_mastery_changes",
        idColumn: "mastery_change_id",
        id: change.id,
        sessionId: session.id,
        payload: change,
        columns: ["evaluation_id", "concept_state_id", "changed_at"],
        values: [change.evaluation_id, change.concept_state_id, change.changed_at],
        entity: "MasteryChange",
      });
    }
    if (session.last_decision !== null) {
      await client.query(
        `INSERT INTO app_state.tutor_adaptive_decisions (session_id, payload, decided_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, decided_at = EXCLUDED.decided_at`,
        [session.id, json(session.last_decision), session.updated_at],
      );
    } else {
      await client.query("DELETE FROM app_state.tutor_adaptive_decisions WHERE session_id = $1", [session.id]);
    }
    await client.query(
      `INSERT INTO app_state.tutor_session_snapshots (session_id, payload, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [session.id, json(session), session.updated_at],
    );
  }

  async #assertNormalizedRows(session) {
    const required = [
      ["tutor_flow_states", session.flow_state],
      ["tutor_learner_states", session.learner_state],
      ["tutor_probe_sessions", session.probe_session],
      ["tutor_current_exercises", session.current_exercise],
    ];
    for (const [table, expected] of required) {
      const result = await this.#pool.query(
        `SELECT payload FROM app_state.${table} WHERE session_id = $1`,
        [session.id],
      );
      if (expected === null) {
        if (result.rowCount !== 0) throw new CorruptSessionSnapshotError(session.id);
      } else if (result.rowCount !== 1 || !sameJson(result.rows[0].payload, expected)) {
        throw new CorruptSessionSnapshotError(session.id);
      }
    }
    const [attempts, evaluations, changes] = await Promise.all([
      this.#pool.query("SELECT attempt_id, payload FROM app_state.tutor_attempts WHERE session_id = $1", [session.id]),
      this.#pool.query("SELECT evaluation_id, payload FROM app_state.tutor_evaluations WHERE session_id = $1", [session.id]),
      this.#pool.query("SELECT mastery_change_id, payload FROM app_state.tutor_mastery_changes WHERE session_id = $1", [session.id]),
    ]);
    const ids = (rows, key) => new Set(rows.rows.map((row) => row[key]));
    const sameIds = (actual, expected) => actual.size === expected.length
      && expected.every((item) => actual.has(item));
    const samePayloads = (rows, expected, idKey, expectedId) => rows.rows.length === expected.length
      && expected.every((item) => {
        const row = rows.rows.find((candidate) => candidate[idKey] === expectedId(item));
        return row && sameJson(row.payload, item);
      });
    if (!sameIds(ids(attempts, "attempt_id"), session.attempts.map((item) => item.id))
      || !sameIds(ids(evaluations, "evaluation_id"), session.evaluations.map((item) => item.evaluation.id))
      || !sameIds(ids(changes, "mastery_change_id"), session.mastery_changes.map((item) => item.id))
      || !samePayloads(attempts, session.attempts, "attempt_id", (item) => item.id)
      || !samePayloads(evaluations, session.evaluations, "evaluation_id", (item) => item.evaluation.id)
      || !samePayloads(changes, session.mastery_changes, "mastery_change_id", (item) => item.id)) {
      throw new CorruptSessionSnapshotError(session.id);
    }
  }
}

export function createPostgresSessionStoreFromEnv(env = process.env) {
  const pool = new Pool({
    host: env.SQL_MENTOR_POSTGRES_HOST || "127.0.0.1",
    port: integer(env.SQL_MENTOR_POSTGRES_PORT, "SQL_MENTOR_POSTGRES_PORT", 5_432),
    database: env.SQL_MENTOR_POSTGRES_DB || "sql_mentor",
    user: required(env.SQL_MENTOR_POSTGRES_USER, "SQL_MENTOR_POSTGRES_USER"),
    password: required(env.SQL_MENTOR_POSTGRES_PASSWORD, "SQL_MENTOR_POSTGRES_PASSWORD"),
    application_name: "sql-mentor-ai-persistence",
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000,
    max: 2,
  });
  return new PostgresSessionStore({ pool });
}
