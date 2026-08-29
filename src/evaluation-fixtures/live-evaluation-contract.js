export const LIVE_EVALUATION_INSTRUCTIONS = [
  "Você é avaliador pedagógico de SQL.",
  "Responda somente JSON, sem Markdown, SQL, SELECT/FROM, fragmentos de consulta ou solução.",
  "Use no máximo duas frases curtas em message_to_learner.",
  "Use no máximo dois hints e duas misconceptions; cada item deve ser curto.",
  "Use arrays vazios quando não houver dica ou misconception suportada pelas evidências.",
  "Formato compacto obrigatório: {\"next_action\":\"practice\",\"message_to_learner\":\"feedback curto\",\"hints\":[],\"misconceptions\":[]}.",
].join(" ");

export const LIVE_EVALUATION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["next_action", "message_to_learner", "hints", "misconceptions"],
  properties: {
    next_action: {
      type: "string",
      enum: ["retry", "reteach", "practice", "advance", "review"],
      description: "A única ação pedagógica recomendada com base nas evidências da tentativa.",
    },
    message_to_learner: {
      type: "string",
      minLength: 1,
      maxLength: 280,
      description: "Feedback curto para o aluno, sem SQL, sem solução e sem bloco de código.",
    },
    hints: {
      type: "array",
      maxItems: 2,
      description: "No máximo duas dicas graduais que orientam sem revelar a consulta SQL correta.",
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
    misconceptions: {
      type: "array",
      maxItems: 2,
      description: "No máximo duas concepções incorretas observadas; vazio quando não houver evidência.",
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
  },
});

export function liveEvaluationAdapterEnv(env) {
  return Object.freeze({
    ...env,
    LLM_MAX_OUTPUT_TOKENS: env.LLM_EVAL_MAX_OUTPUT_TOKENS ?? "320",
  });
}

export function solutionLeakCorrectionMessage() {
  return JSON.stringify({
    kind: "pedagogical_output_correction",
    rejection_code: "solution_leak",
    instruction: "Gere nova resposta curta, sem SQL, fragmentos de consulta, SELECT/FROM ou solução completa; use apenas orientação conceitual e socrática.",
  });
}

export function shouldRetryLiveFormatError(errorCode) {
  return ["malformed_json", "missing_output", "output_schema_mismatch"].includes(errorCode);
}

export function outputFormatCorrectionMessage() {
  return JSON.stringify({
    kind: "pedagogical_output_correction",
    rejection_code: "output_format",
    instruction: "Gere novamente um único JSON completo no schema solicitado. Mantenha message_to_learner curto, use no máximo dois itens por array e não escreva texto fora do JSON.",
  });
}
