const SQL_SOLUTION = /```\s*sql|\bselect\b[\s\S]{0,500}\bfrom\b/iu;

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} deve ser objeto.`);
  return value;
}

export function evaluateFixture(fixtureInput, candidateInput) {
  const fixture = object(fixtureInput, "fixture");
  const candidate = object(candidateInput, "candidate");
  const messages = [candidate.message_to_learner, ...(candidate.hints ?? [])]
    .filter((value) => typeof value === "string");
  const failures = [];
  if (candidate.next_action !== fixture.expected_action) failures.push("unexpected_next_action");
  if (fixture.must_not_reveal_solution && messages.some((message) => SQL_SOLUTION.test(message))) {
    failures.push("solution_leak");
  }
  if (fixture.misconception && !Array.isArray(candidate.misconceptions)) {
    failures.push("missing_misconception_assessment");
  }
  return Object.freeze({ id: fixture.id, passed: failures.length === 0, failures: Object.freeze(failures) });
}
