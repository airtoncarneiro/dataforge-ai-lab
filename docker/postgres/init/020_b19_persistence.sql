\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS app_state;

CREATE TABLE IF NOT EXISTS app_state.persistence_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_state.tutor_learning_sessions (
  session_id text PRIMARY KEY,
  learning_goal text NOT NULL,
  status text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_session_snapshots (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_learner_states (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  learner_state_id text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_probe_sessions (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  probe_session_id text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_flow_states (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_current_exercises (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_attempts (
  attempt_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  payload jsonb NOT NULL,
  submitted_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tutor_attempts_session_id_idx
  ON app_state.tutor_attempts(session_id, submitted_at);

CREATE TABLE IF NOT EXISTS app_state.tutor_evaluations (
  evaluation_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  attempt_id text NOT NULL UNIQUE REFERENCES app_state.tutor_attempts(attempt_id),
  payload jsonb NOT NULL,
  evaluated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state.tutor_mastery_changes (
  mastery_change_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  evaluation_id text NOT NULL REFERENCES app_state.tutor_evaluations(evaluation_id),
  concept_state_id text NOT NULL,
  payload jsonb NOT NULL,
  changed_at timestamptz NOT NULL,
  UNIQUE(evaluation_id, concept_state_id)
);

CREATE TABLE IF NOT EXISTS app_state.tutor_adaptive_decisions (
  session_id text PRIMARY KEY REFERENCES app_state.tutor_learning_sessions(session_id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  decided_at timestamptz NOT NULL
);

INSERT INTO app_state.persistence_schema_migrations (version)
VALUES ('b19-persistence-v1')
ON CONFLICT (version) DO NOTHING;

REVOKE ALL ON ALL TABLES IN SCHEMA app_state FROM mentor_sandbox;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app_state FROM mentor_sandbox;
