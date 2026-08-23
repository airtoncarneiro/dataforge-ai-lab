#!/usr/bin/env node

import process from "node:process";

import { createTutorApplicationFromEnv } from "./orchestrator/index.js";
import { NodeTerminalIO, TerminalConversationLoop } from "./terminal/index.js";

export const VERSION = "0.1.0";

export function helpText() {
  return [
    "SQL Mentor AI",
    "",
    "Uso:",
    "  npm start              inicia com o provider configurado",
    "  npm run demo           inicia sem chamadas reais à LLM",
    "  npm start -- --help     mostra esta ajuda",
    "  npm start -- --version  mostra a versão",
    "",
    "SQL multilinha: finalize a submissão com .enviar em uma linha separada.",
  ].join("\n");
}

export function foundationStatus({ demo = false } = {}) {
  return [
    "SQL Mentor AI — Terminal conversation loop B18",
    demo
      ? "LLM: provider demo determinístico (sem rede)."
      : "LLM: provider configurado pelo ambiente.",
    "SQL: execução real exclusivamente pelo Sandbox PostgreSQL.",
    "Estado: mantido somente em memória nesta versão.",
  ].join("\n");
}

export async function runCli({
  input = process.stdin,
  output = process.stdout,
  args = process.argv.slice(2),
  env = process.env,
  applicationFactory = createTutorApplicationFromEnv,
  ioFactory = (options) => new NodeTerminalIO(options),
  loopFactory = (options) => new TerminalConversationLoop(options),
  loadLocalEnv = env === process.env,
} = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    output.write(`${helpText()}\n`);
    return Object.freeze({ reason: "help", session: null });
  }
  if (args.includes("--version") || args.includes("-v")) {
    output.write(`${VERSION}\n`);
    return Object.freeze({ reason: "version", session: null });
  }

  if (loadLocalEnv && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        output.write("[ERRO] O arquivo .env local não pôde ser carregado.\n");
        return Object.freeze({ reason: "configuration_error", session: null });
      }
    }
  }

  const demo = args.includes("--demo");
  output.write(`${foundationStatus({ demo })}\n`);
  try {
    const application = await applicationFactory({ env, demo });
    const io = ioFactory({ input, output });
    return await loopFactory({ application, io }).run();
  } catch {
    output.write("[ERRO] Não foi possível iniciar a sessão. Verifique a configuração local.\n");
    return Object.freeze({ reason: "configuration_error", session: null });
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(process.argv[1], "file:").href;

if (invokedDirectly) {
  const result = await runCli();
  if (["configuration_error", "application_error"].includes(result.reason)) {
    process.exitCode = 1;
  }
}
