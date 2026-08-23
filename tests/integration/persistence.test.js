import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { createTutorApplicationFromEnv } from "../../src/orchestrator/index.js";
import {
  CorruptSessionSnapshotError,
  IdempotencyConflictError,
  PostgresSessionStore,
  SessionNotFoundError,
} from "../../src/persistence/index.js";
import { createSqlSandboxFromEnv } from "../../src/sandbox/sql-sandbox.js";

function persistenceEnv() {
  return {
    ...process.env,
    SQL_MENTOR_PROBE_MAX_QUESTIONS: "5",
    SQL_MENTOR_TARGET_DIFFICULTY: "medium",
    SQL_MENTOR_SANDBOX_MAX_ROWS: "20",
  };
}

function createStore(env) {
  const pool = new pg.Pool({
    host: env.SQL_MENTOR_POSTGRES_HOST || "127.0.0.1",
    port: Number(env.SQL_MENTOR_POSTGRES_PORT || 5432),
    database: env.SQL_MENTOR_POSTGRES_DB || "sql_mentor",
    user: env.SQL_MENTOR_POSTGRES_USER,
    password: env.SQL_MENTOR_POSTGRES_PASSWORD,
    max: 1,
  });
  return { pool, store: new PostgresSessionStore({ pool }) };
}

async function reachExercise(application) {
  await application.start({ learningGoal: "Quero aprender SQL" });
  for (const answer of [
    "SELECT projeta as colunas solicitadas.",
    "SELECT escolhe expressões para o resultado.",
    "Eu evitaria SELECT * quando conheço as colunas.",
    "A projeção explícita documenta o resultado.",
    "Eu selecionaria customer_id e name.",
  ]) {
    await application.submitProbeAnswer(answer);
  }
  await application.prepareLearningCycle();
  assert.equal(application.session.flow_state.phase, "PRACTICE");
  assert.notEqual(application.session.current_exercise, null);
}

test("B19 persiste, recupera e idempotentemente conclui o ciclo Attempt→Evaluation→MasteryChange", async () => {
  const env = persistenceEnv();
  const first = await createTutorApplicationFromEnv({ env, demo: true });
  let firstClosed = false;
  try {
    await reachExercise(first);
    const beforeRestart = first.session;
    const sessionId = beforeRestart.id;

    await first.close();
    firstClosed = true;
    const resumedBeforeAttempt = await createTutorApplicationFromEnv({ env, demo: true });
    try {
      const recovered = await resumedBeforeAttempt.resume(sessionId);
      assert.equal(recovered.session.id, sessionId);
      assert.equal(resumedBeforeAttempt.session.current_exercise.exercise.id,
        beforeRestart.current_exercise.exercise.id);
      assert.equal(resumedBeforeAttempt.session.flow_state.transition_sequence,
        beforeRestart.flow_state.transition_sequence);

      await resumedBeforeAttempt.submitSql(
        "SELECT customer_id, name FROM customers ORDER BY customer_id",
      );
      const completed = resumedBeforeAttempt.session;
      assert.equal(completed.attempts.length, 1);
      assert.equal(completed.evaluations.length, 1);
      assert.equal(completed.mastery_changes.length > 0, true);
      assert.notEqual(completed.last_decision, null);
      assert.equal(completed.policy_version, "terminal-application-policy-v1");

      const finalTimestamp = completed.updated_at;
      await resumedBeforeAttempt.close();
      const resumedAfterAttempt = await createTutorApplicationFromEnv({ env, demo: true });
      try {
        await resumedAfterAttempt.resume(sessionId);
        assert.equal(resumedAfterAttempt.session.attempts.length, 1);
        assert.equal(resumedAfterAttempt.session.evaluations.length, 1);
        assert.equal(resumedAfterAttempt.session.mastery_changes.length,
          completed.mastery_changes.length);
        assert.equal(resumedAfterAttempt.session.updated_at, finalTimestamp);
        assert.equal(resumedAfterAttempt.session.evaluations[0].evaluation.id,
          completed.evaluations[0].evaluation.id);
      } finally {
        await resumedAfterAttempt.close();
      }
    } finally {
      await resumedBeforeAttempt.close();
    }
  } finally {
    if (!firstClosed) await first.close();
  }
});

test("B19 rejeita reprocessamento divergente e faz rollback do snapshot", async () => {
  const env = persistenceEnv();
  const application = await createTutorApplicationFromEnv({ env, demo: true });
  try {
    await reachExercise(application);
    await application.submitSql("SELECT customer_id, name FROM customers ORDER BY customer_id");
    const original = application.session;
    const { store } = createStore(env);
    try {
      await store.migrate();
      await store.saveEvaluation(original.id, original.evaluations[0]);
      await store.saveMasteryChanges(original.id, original.mastery_changes);
      const duplicateAttempt = {
        ...original.attempts[0],
        submission: "SELECT 999",
      };
      await assert.rejects(
        store.saveSessionSnapshot({
          ...original,
          attempts: [...original.attempts, duplicateAttempt],
        }),
        IdempotencyConflictError,
      );
      assert.deepEqual(await store.loadSessionSnapshot(original.id), original);
    } finally {
      await store.close();
    }
  } finally {
    await application.close();
  }
});

test("B19 mantém app_state isolado do mentor_sandbox", async () => {
  const sandbox = createSqlSandboxFromEnv(persistenceEnv());
  try {
    const result = await sandbox.execute("SELECT count(*) FROM app_state.tutor_learning_sessions");
    assert.equal(result.status, "error");
    assert.equal(result.error.category, "security_violation");
  } finally {
    await sandbox.close();
  }
});

test("B19 sinaliza sessão inexistente e snapshot corrompido sem fallback", async () => {
  const env = persistenceEnv();
  const application = await createTutorApplicationFromEnv({ env, demo: true });
  try {
    await assert.rejects(application.resume("learning-session:inexistente"), SessionNotFoundError);
    await reachExercise(application);
    const { store, pool } = createStore(env);
    try {
      const sessionId = application.session.id;
      await pool.query(
        "UPDATE app_state.tutor_session_snapshots SET payload = '{}'::jsonb WHERE session_id = $1",
        [sessionId],
      );
      await assert.rejects(store.loadSessionSnapshot(sessionId), CorruptSessionSnapshotError);
    } finally {
      await store.close();
    }
  } finally {
    await application.close();
  }
});
