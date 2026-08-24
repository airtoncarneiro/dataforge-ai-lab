export const LOG_SCHEMA_VERSION = "log-event-v1";
export const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);

export const LOG_EVENT_NAMES = Object.freeze([
  "session.started", "session.recovered", "session.ended", "session.failed",
  "probe.started", "probe.answer_processed", "probe.completed",
  "flow.transitioned", "exercise.generated", "exercise.generation_failed",
  "attempt.submitted", "sql.validated", "evaluation.completed",
  "learner_state.updated", "adaptive_decision.made",
  "persistence.saved", "persistence.failed", "llm.request.completed", "llm.request.failed",
]);

export function assertLogger(logger) {
  if (!logger || typeof logger.log !== "function") {
    throw new TypeError("Logger deve implementar log(event).");
  }
  return logger;
}

export function createLogEvent({
  timestamp = new Date().toISOString(),
  level = "info",
  event_name,
  policy_version = null,
  correlation = {},
  operation = {},
  error = null,
  data = {},
}) {
  if (!LOG_LEVELS.includes(level)) throw new TypeError("Nível de log inválido.");
  if (!LOG_EVENT_NAMES.includes(event_name)) throw new TypeError("event_name de log inválido.");
  if (typeof timestamp !== "string" || Number.isNaN(new Date(timestamp).getTime())) {
    throw new TypeError("timestamp do log deve ser ISO-8601.");
  }
  return Object.freeze({
    timestamp,
    level,
    event_name,
    schema_version: LOG_SCHEMA_VERSION,
    policy_version: typeof policy_version === "string" ? policy_version : null,
    correlation: Object.freeze({
      session_id: correlation.session_id ?? null,
      exercise_id: correlation.exercise_id ?? null,
      attempt_id: correlation.attempt_id ?? null,
      evaluation_id: correlation.evaluation_id ?? null,
      llm_request_id: correlation.llm_request_id ?? null,
    }),
    operation: Object.freeze({
      status: operation.status ?? "unknown",
      duration_ms: Number.isFinite(operation.duration_ms) ? operation.duration_ms : null,
      attempts: Number.isSafeInteger(operation.attempts) ? operation.attempts : null,
    }),
    error: error === null ? null : Object.freeze({
      category: error.category ?? "operation_error",
      code: error.code ?? "unknown",
      sqlstate: error.sqlstate ?? null,
      retryable: Boolean(error.retryable),
    }),
    data: Object.freeze(data),
  });
}
