import assert from "node:assert/strict";
import test from "node:test";

import { createMentorWebServer } from "../../src/web/server.js";

function result(session, events = []) {
  return { session, events };
}

test("web server é criado sem iniciar listener automaticamente", () => {
  const server = createMentorWebServer({ applicationFactory: async () => ({}) });
  assert.equal(typeof server.listen, "function");
  assert.equal(server.listening, false);
});

test("web server conduz sessão, probe, prévia e submissão SQL", async (t) => {
  const session = { id: "session-web", phase: "PROBE", flow_state: { phase: "PROBE" } };
  const application = {
    session,
    async start() { return result(session, [{ type: "probe_question", data: { number: 1, max_questions: 5, question: "O que é SELECT?" } }]); },
    async resume(id) { assert.equal(id, "session-web"); return result(session, [{ type: "session_resumed", data: { session_id: id, phase: "PROBE", message: "Sessão recuperada." } }]); },
    async submitProbeAnswer(answer) { assert.equal(answer, "Uma projeção"); session.phase = "PRACTICE"; session.flow_state.phase = "PRACTICE"; return result(session, [{ type: "exercise", data: { objective: "Listar clientes", statement: "Liste os clientes.", difficulty: 1, concepts: ["select"] } }]); },
    async prepareLearningCycle() { return result(session, [{ type: "teach", data: { message: "Use projeção explícita." } }]); },
    async previewSql(sql) { assert.equal(sql, "SELECT customer_id FROM customers"); return result(session, [{ type: "preview_execution", data: { status: "ok", columns: ["customer_id"], rows: [{ customer_id: 1 }], row_count: 1 } }]); },
    async submitSql(sql) { assert.equal(sql, "SELECT customer_id FROM customers"); return result(session, [{ type: "execution", data: { status: "correct", columns: [], rows: [], row_count: 1 } }]); },
  };
  const server = createMentorWebServer({ applicationFactory: async () => application });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "sql-mentor-ai" });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Comece sua sessão/u);

  const started = await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ learning_goal: "SQL" }),
  });
  assert.equal(started.status, 201);
  assert.equal((await started.json()).session_id, "session-web");

  const resumed = await fetch(`${base}/api/sessions/${encodeURIComponent("session-web")}/resume`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).session_id, "session-web");

  const probe = await fetch(`${base}/api/sessions/${encodeURIComponent("session-web")}/probe`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Uma projeção" }),
  });
  assert.equal(probe.status, 200);

  const preview = await fetch(`${base}/api/sessions/${encodeURIComponent("session-web")}/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT customer_id FROM customers" }),
  });
  assert.equal(preview.status, 200);

  const submitted = await fetch(`${base}/api/sessions/${encodeURIComponent("session-web")}/sql`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT customer_id FROM customers" }),
  });
  assert.equal(submitted.status, 200);
});
