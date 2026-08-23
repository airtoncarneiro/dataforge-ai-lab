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

test("exibe ajuda sem iniciar o loop interativo", () => {
  const output = captureOutput();

  runCli({ args: ["--help"], output: output.stream, input: { isTTY: false } });

  assert.equal(output.value(), `${helpText()}\n`);
  assert.match(output.value(), /npm start/);
});

test("exibe a versao", () => {
  const output = captureOutput();

  runCli({ args: ["--version"], output: output.stream, input: { isTTY: false } });

  assert.equal(output.value(), `${VERSION}\n`);
});

test("inicia em modo nao interativo e informa o limite da fundacao", () => {
  const output = captureOutput();

  runCli({ args: [], output: output.stream, input: { isTTY: false } });

  assert.equal(output.value(), `${foundationStatus()}\n`);
  assert.match(output.value(), /B01-B03/);
});

