import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL("../fixtures/llm-evaluation/b25-evaluation-fixtures.json", import.meta.url);
const required = new Set([
  "beginner_select", "intermediate_join", "lucky_correct", "null_misconception",
  "left_join_where", "group_by_error", "alternative_correct_query", "correct_query_wrong_explanation",
]);

test("B25 mantém os oito fixtures pedagógicos versionáveis e sem solução", async () => {
  const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(fixtures.length, 8);
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.id)), required);
  for (const fixture of fixtures) {
    assert.equal(typeof fixture.expected_action, "string");
    assert.equal(fixture.must_not_reveal_solution, true);
    assert.doesNotMatch(JSON.stringify(fixture), /reference_query|reference_solution|\bselect\b[\s\S]*\bfrom\b/iu);
  }
});
