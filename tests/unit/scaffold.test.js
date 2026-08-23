import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const componentBoundaries = [
  "src/orchestrator/README.md",
  "src/llm/README.md",
  "src/sandbox/README.md",
  "src/learner-model/README.md",
];

test("mantem as fronteiras arquiteturais exigidas em B01", async () => {
  await Promise.all(componentBoundaries.map((path) => access(path)));
});

test("protege arquivos locais de ambiente sem ocultar o exemplo", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

