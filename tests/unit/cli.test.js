import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { foundationStatus, helpText, runCli, VERSION } from "../../src/cli.js";

function captureOutput() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  });
  return { stream, value: () => value };
}

test("exibe ajuda sem iniciar o loop interativo", async () => {
  const output = captureOutput();
  let factoryCalled = false;
  await runCli({
    args: ["--help"], output: output.stream, input: {}, loadLocalEnv: false,
    applicationFactory: async () => { factoryCalled = true; },
  });
  assert.equal(output.value(), `${helpText()}\n`);
  assert.match(output.value(), /npm run demo/);
  assert.equal(factoryCalled, false);
});

test("exibe a versão", async () => {
  const output = captureOutput();
  await runCli({ args: ["--version"], output: output.stream, input: {}, loadLocalEnv: false });
  assert.equal(output.value(), `${VERSION}\n`);
});

test("inicia B18 e propaga explicitamente o modo demo", async () => {
  const output = captureOutput();
  const calls = [];
  const result = await runCli({
    args: ["--demo"], env: {}, output: output.stream, input: {}, loadLocalEnv: false,
    applicationFactory: async (options) => {
      calls.push(["factory", options.demo]);
      return { id: "application" };
    },
    ioFactory: () => ({ id: "io" }),
    loopFactory: ({ application, io }) => ({
      async run() {
        calls.push(["loop", application.id, io.id]);
        return { reason: "manual_exit", session: null };
      },
    }),
  });
  assert.equal(result.reason, "manual_exit");
  assert.deepEqual(calls, [["factory", true], ["loop", "application", "io"]]);
  assert.equal(output.value(), `${foundationStatus({ demo: true })}\n`);
  assert.match(output.value(), /B18/);
});

test("falha de configuração é sanitizada", async () => {
  const output = captureOutput();
  const result = await runCli({
    args: [], env: {}, output: output.stream, input: {}, loadLocalEnv: false,
    applicationFactory: async () => {
      throw new Error("postgres://mentor_sandbox:secret@internal/database");
    },
  });
  assert.equal(result.reason, "configuration_error");
  assert.doesNotMatch(output.value(), /secret|postgres:\/\//iu);
  assert.match(output.value(), /configuração local/iu);
});
