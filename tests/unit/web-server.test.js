import assert from "node:assert/strict";
import test from "node:test";

import { createMentorWebServer } from "../../src/web/server.js";

test("web server é criado sem iniciar listener automaticamente", () => {
  const server = createMentorWebServer({ applicationFactory: async () => ({}) });
  assert.equal(typeof server.listen, "function");
  assert.equal(server.listening, false);
});
