export const SOCRATIC_RETRY_POLICY_VERSION = "socratic-retry-policy-v1";

const TECHNICAL_QUESTIONS = Object.freeze({
  syntax_error: "Qual parte da mensagem indica onde a sintaxe da consulta deixou de ser válida?",
  security_violation: "A consulta usa somente uma leitura permitida sobre o schema educacional?",
  timeout: "Há alguma operação que você pode simplificar antes de tentar novamente?",
  execution_error: "Qual nome de tabela, coluna ou função precisa ser conferido no schema disponível?",
  reference_validation_error: "A execução não produziu uma comparação válida. Qual parte da consulta você pode revisar primeiro?",
});

const TECHNICAL_HINTS = Object.freeze({
  syntax_error: "Revise palavras-chave, vírgulas, parênteses e nomes de colunas antes de reenviar.",
  security_violation: "Use uma única consulta SELECT/CTE de leitura e apenas relações permitidas.",
  timeout: "Comece por uma versão menor da consulta e adicione operações uma a uma.",
  execution_error: "Confira os nomes no enunciado e no schema educacional antes de reenviar.",
  reference_validation_error: "Reescreva a consulta de forma simples, mantendo apenas os requisitos do enunciado.",
});

function text(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} deve ser uma string não vazia.`);
  }
  return value;
}

function retryCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("retryCount deve ser inteiro não negativo.");
  }
  return value;
}

function category(value) {
  return TECHNICAL_QUESTIONS[value] ? value : "execution_error";
}

// B10/State Machine own the retry limit. B21 only controls the intervention.
export function createSocraticRetry({ executionError, retryCount: count, evaluatorHints = [] }) {
  const error = executionError ?? {};
  const errorCategory = category(text(error.category ?? "execution_error", "executionError.category"));
  const currentRetry = retryCount(count);
  if (!Array.isArray(evaluatorHints) || evaluatorHints.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError("evaluatorHints deve ser um array de strings não vazias.");
  }
  const stage = currentRetry === 0 ? "question" : "hint";
  const message = stage === "question"
    ? TECHNICAL_QUESTIONS[errorCategory]
    : evaluatorHints[0] ?? TECHNICAL_HINTS[errorCategory];
  return Object.freeze({
    stage,
    message,
    retry_number: currentRetry + 1,
    policy_version: SOCRATIC_RETRY_POLICY_VERSION,
  });
}
