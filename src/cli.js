#!/usr/bin/env node

import { createInterface } from "node:readline";
import process from "node:process";

export const VERSION = "0.1.0";

export function helpText() {
  return [
    "SQL Mentor AI",
    "",
    "Uso:",
    "  npm start              inicia a aplicacao de terminal",
    "  npm start -- --help     mostra esta ajuda",
    "  npm start -- --version  mostra a versao",
  ].join("\n");
}

export function foundationStatus() {
  return [
    "SQL Mentor AI — fundacao B01-B03",
    "PostgreSQL educacional: configurado via Docker Compose.",
    "Fluxo pedagogico: sera implementado a partir de B04.",
  ].join("\n");
}

export function runCli({ input = process.stdin, output = process.stdout, args = process.argv.slice(2) } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    output.write(`${helpText()}\n`);
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    output.write(`${VERSION}\n`);
    return;
  }

  output.write(`${foundationStatus()}\n`);

  if (!input.isTTY) {
    return;
  }

  output.write("Digite 'status' para rever o estado ou 'sair' para encerrar.\n");
  const terminal = createInterface({ input, output, prompt: "sql-mentor> " });
  terminal.prompt();

  terminal.on("line", (line) => {
    const command = line.trim().toLowerCase();

    if (command === "sair" || command === "exit" || command === "quit") {
      terminal.close();
      return;
    }

    if (command === "status") {
      output.write(`${foundationStatus()}\n`);
    } else if (command) {
      output.write("Comando ainda nao disponivel nesta fundacao.\n");
    }

    terminal.prompt();
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;

if (invokedDirectly) {
  runCli();
}

