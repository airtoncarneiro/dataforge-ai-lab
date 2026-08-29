export function summarizeB27(records) {
  const total = records.length;
  const completed = records.filter((record) => record.status === "ok");
  const failures = records.filter((record) => record.status !== "ok");
  const count = (predicate) => records.filter(predicate).length;
  return Object.freeze({
    total,
    completed: completed.length,
    provider_errors: failures.length,
    passed: count((record) => record.evaluation?.passed === true),
    json_valid: completed.length,
    expected_action_match: count((record) => record.evaluation?.expected_action_match === true),
    solution_leak_free: count((record) => record.evaluation?.solution_leak_free === true),
    average_latency_ms: completed.length === 0
      ? null
      : Math.round(completed.reduce((sum, record) => sum + record.duration_ms, 0) / completed.length),
    error_codes: Object.freeze(failures.reduce((result, record) => {
      const code = record.error_code ?? "provider_error";
      result[code] = (result[code] ?? 0) + 1;
      return result;
    }, {})),
  });
}
