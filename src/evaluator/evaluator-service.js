import { createHash } from "node:crypto";

import { ADAPTIVE_ACTIONS } from "../adaptive-decision/index.js";
import {
  DomainValidationError,
  createAttempt,
  createEvaluation,
  createExercise,
  createLearnerState,
} from "../domain/index.js";
import { toLearnerExercise } from "../exercise/index.js";
import {
  SQL_KNOWLEDGE_GRAPH,
  UnknownKnowledgeConceptError,
} from "../knowledge-graph/index.js";
import { createTutorPolicyContextBuilder } from "../tutor-policy/index.js";
import {
  EVALUATOR_POLICY_VERSION,
  EvaluatorValidationError,
  assertResultValidation,
  createEvaluatorResult,
} from "./contracts.js";
import { EVALUATOR_LLM_OUTPUT_SCHEMA } from "./schemas.js";

const INPUT_KEYS = new Set([
  "exercise",
  "attempt",
  "validationResult",
  "learnerState",
  "evaluatedConcepts",
  "recentMessages",
]);

const INTERNAL_EXERCISE_KEYS = new Set([
  "id",
  "concepts",
  "difficulty",
  "objective",
  "statement",
  "expected_skills",
  "validation_strategy",
  "evaluation_notes",
  "reference_solution",
  "created_at",
]);

const PUBLIC_EXERCISE_KEYS = new Set([
  "id",
  "concepts",
  "difficulty",
  "objective",
  "statement",
  "expected_skills",
  "validation_strategy",
  "created_at",
]);

const TECHNICAL_STATUSES = new Set([
  "execution_error",
  "security_violation",
  "timeout",
  "reference_validation_error",
]);

const STRENGTH_RANK = Object.freeze({ weak: 0, medium: 1, strong: 2 });
const STRENGTHS = Object.freeze(["weak", "medium", "strong"]);

const CONSTRAINT_CONCEPTS = Object.freeze({
  "query.has_join": "join",
  "query.has_group_by": "group_by",
  "query.has_aggregate": "aggregate_functions",
  "query.has_window_function": "window_functions",
  "query.has_cte": "cte",
  "query.has_subquery": "subqueries",
  "query.has_order_by": "order_by",
  "query.has_where": "where",
  "plan.index_name": "indexes",
  "plan.node_type": "query_optimization",
});

function fail(code, message) {
  throw new EvaluatorValidationError(code, message);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  return value;
}

function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field", `${path}.${key} não é permitido.`);
  }
}

function strings(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail("invalid_shape", `${path} deve conter ao menos ${min} item(ns).`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      fail("invalid_value", `${path}[${index}] deve ser string não vazia.`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    fail("duplicate_value", `${path} não deve conter valores duplicados.`);
  }
  return Object.freeze(result);
}

function stableId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}:${digest}`;
}

function nowFrom(clock) {
  const value = clock();
  let canonical = null;
  try {
    canonical = typeof value === "string" ? new Date(value).toISOString() : null;
  } catch {
    canonical = null;
  }
  if (canonical !== value) {
    fail("invalid_clock", "clock deve retornar timestamp ISO canônico.");
  }
  return value;
}

function normalizeExercise(input) {
  const value = record(input, "EvaluatorInput.exercise");
  const internal = Object.keys(value).some((key) => [
    "evaluation_notes",
    "reference_solution",
  ].includes(key));
  exactKeys(
    value,
    internal ? INTERNAL_EXERCISE_KEYS : PUBLIC_EXERCISE_KEYS,
    "EvaluatorInput.exercise",
  );
  try {
    return toLearnerExercise(createExercise(internal ? value : {
      ...value,
      evaluation_notes: [],
      reference_solution: null,
    }, "EvaluatorInput.exercise"));
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail("invalid_exercise", "exercise não atende ao contrato B07/B15.");
    }
    throw error;
  }
}

function normalizeAttempt(input) {
  try {
    return createAttempt(input, "EvaluatorInput.attempt");
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail("invalid_attempt", "attempt não atende ao contrato B07.");
    }
    throw error;
  }
}

function normalizeLearnerState(input) {
  try {
    return createLearnerState(input, "EvaluatorInput.learnerState");
  } catch (error) {
    if (error instanceof DomainValidationError) {
      fail("invalid_learner_state", "learnerState não atende ao contrato B07.");
    }
    throw error;
  }
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function executionCategory(validation) {
  if (validation.status === "security_violation") return "security_violation";
  if (validation.status === "timeout") return "timeout";
  if (validation.status === "reference_validation_error") return "execution_error";
  if (validation.status !== "execution_error") return null;
  const category = validation.execution?.error?.category;
  return ["syntax_error", "security_violation", "timeout", "execution_error"]
    .includes(category)
    ? category
    : "execution_error";
}

function executionErrorFor(validation) {
  const category = executionCategory(validation);
  if (category === null) return null;
  const messages = {
    syntax_error: "A consulta contém um erro de sintaxe e não foi executada.",
    security_violation: "A consulta foi recusada pela política de segurança do sandbox.",
    timeout: "A consulta excedeu o tempo máximo de execução permitido.",
    execution_error: validation.status === "reference_validation_error"
      ? "A tentativa não pôde ser avaliada por uma falha interna do exercício."
      : "O PostgreSQL não conseguiu concluir a consulta.",
  };
  const sqlstate = validation.execution?.error?.sqlstate;
  return Object.freeze({
    category,
    sqlstate: typeof sqlstate === "string" && /^[0-9A-Z]{5}$/u.test(sqlstate)
      ? sqlstate
      : null,
    message: messages[category],
  });
}

function objectiveAssessment(validation) {
  return Object.freeze({
    status: validation.status,
    correct: validation.correct,
    execution_status: validation.execution?.status ?? "not_executed",
    expected_summary: validation.expected_summary,
    actual_summary: validation.actual_summary,
    mismatches: validation.mismatches,
    constraints: validation.constraints,
    plan_evidence: validation.plan_evidence,
  });
}

function publicExecutionEvidence(validation) {
  if (validation.execution === null) return null;
  const error = executionErrorFor(validation);
  return Object.freeze({
    status: validation.execution.status,
    columns: validation.execution.columns,
    rows: validation.execution.rows,
    row_count: validation.execution.row_count,
    truncated: validation.execution.truncated,
    duration_ms: validation.execution.duration_ms,
    error,
    explain: validation.plan_evidence,
  });
}

function authoritativeDirective(validation) {
  return Object.freeze({
    kind: "authoritative_result_validation",
    authority: "B16 Result Validator facts must not be changed or reclassified.",
    objective_assessment: objectiveAssessment(validation),
    rules: Object.freeze([
      "Do not return objective correct, execution status, mismatches, constraints or plan evidence.",
      "Interpret only pedagogical meaning supported by these facts.",
      "Do not infer mastery from sophisticated wording or a single correct result.",
      "Do not reveal a full SQL answer; prefer a Socratic prompt and graduated hints.",
      "Suggested next action is advisory; B10 remains authoritative.",
    ]),
  });
}

function evaluatorInstructions(base) {
  return [
    base,
    "",
    "## Evaluator B17 deterministic boundaries",
    "- The authoritative_result_validation message contains immutable facts produced by B16.",
    "- Never invent or override execution, objective correctness, mismatches, constraints or plan facts.",
    "- Return only pedagogical interpretation supported by the supplied evidence.",
    "- Mastery evidence is a suggestion for B08; never provide a final mastery score.",
    "- suggested_next_action is advisory; B10 makes the final decision.",
    "- Never reveal a reference query, complete solution, credential, stack trace or internal payload.",
  ].join("\n");
}

function evidenceDetails(entries) {
  return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

function evidence({ attempt, timestamp, source, description, details, polarity, ordinal }) {
  return Object.freeze({
    id: stableId(
      `evaluation-evidence-${polarity}`,
      attempt.id,
      source,
      description,
      String(ordinal),
    ),
    source,
    description,
    details: evidenceDetails(details),
    observed_at: timestamp,
  });
}

function constraintSource(constraint) {
  if (constraint.kind === "query_structure") return "query_structure";
  if (constraint.kind === "plan_property") return "explain";
  return "validation";
}

function objectiveEvidence(validation, attempt, timestamp) {
  const positive = [];
  const negative = [];
  const baseline = evidence({
    attempt,
    timestamp,
    source: executionCategory(validation) === null ? "validation" : "execution",
    description: validation.correct
      ? "O Result Validator B16 confirmou que a solução satisfaz o exercício."
      : `O Result Validator B16 registrou o status objetivo ${validation.status}.`,
    details: {
      validator_status: validation.status,
      validator_policy_version: validation.validator_policy_version,
    },
    polarity: validation.correct ? "positive" : "negative",
    ordinal: 0,
  });
  (validation.correct ? positive : negative).push(baseline);

  validation.mismatches.forEach((item, index) => {
    negative.push(evidence({
      attempt,
      timestamp,
      source: "validation",
      description: `Mismatch objetivo preservado: ${item.code}.`,
      details: { mismatch_code: item.code, field: item.field },
      polarity: "negative",
      ordinal: index + 1,
    }));
  });

  validation.constraints.forEach((item, index) => {
    const target = item.passed ? positive : negative;
    const polarity = item.passed ? "positive" : "negative";
    target.push(evidence({
      attempt,
      timestamp,
      source: constraintSource(item),
      description: item.passed
        ? `Constraint objetiva satisfeita: ${item.target}.`
        : `Constraint objetiva não satisfeita: ${item.target}.`,
      details: {
        constraint_kind: item.kind,
        constraint_target: item.target,
        passed: item.passed,
      },
      polarity,
      ordinal: index + 1,
    }));
  });
  return { positive, negative };
}

function conceptForConstraint(constraint, evaluatedConcepts) {
  const mapped = CONSTRAINT_CONCEPTS[constraint.target];
  if (mapped && evaluatedConcepts.includes(mapped)) return mapped;
  if (constraint.kind === "plan_property") {
    return evaluatedConcepts.find((concept) => [
      "indexes",
      "explain",
      "query_optimization",
    ].includes(concept)) ?? null;
  }
  return null;
}

function deterministicConceptualErrors(validation, evaluatedConcepts) {
  if (validation.status !== "constraint_violation") return [];
  return validation.constraints
    .filter((constraint) => !constraint.passed)
    .map((constraint) => ({ constraint, concept: conceptForConstraint(
      constraint,
      evaluatedConcepts,
    ) }))
    .filter((item) => item.concept !== null)
    .map(({ constraint, concept }) => ({
      code: `constraint_${constraint.target.replaceAll(/[^a-z0-9]+/giu, "_")}`,
      concept,
      description: `A propriedade obrigatória ${constraint.target} não foi demonstrada pela solução.`,
    }));
}

function objectiveStrengthCap(validation) {
  if (validation.correct) {
    return validation.constraints.some((constraint) => (
      constraint.passed
      && ["query_structure", "plan_property"].includes(constraint.kind)
    )) ? "strong" : "medium";
  }
  return validation.status === "constraint_violation" ? "strong" : "medium";
}

function capStrength(strength, cap) {
  return STRENGTHS[Math.min(STRENGTH_RANK[strength], STRENGTH_RANK[cap])];
}

function hasSolutionLeak(text) {
  return /reference[_ ]?(?:query|solution)/iu.test(text)
    || /```\s*sql/iu.test(text)
    || /\bselect\b[\s\S]{0,500}\bfrom\b/iu.test(text);
}

function assertSafePedagogicalText(output) {
  const texts = [
    output.feedback.message_to_learner,
    ...output.feedback.hints,
    ...output.pedagogical_assessment.conceptual_errors.flatMap(
      (item) => [item.description],
    ),
    ...output.pedagogical_assessment.misconceptions.flatMap(
      (item) => [item.description, item.evidence],
    ),
    ...output.mastery_evidence.map((item) => item.reason),
  ];
  if (texts.some(hasSolutionLeak)) {
    fail("solution_leak", "A saída da LLM tentou expor uma solução SQL completa.");
  }
}

function assertNoObjectiveContradiction(output, validation) {
  const message = output.feedback.message_to_learner;
  if (
    !validation.correct
    && /(?:consulta|query|resultado)\s+(?:está|é|foi)\s+(?:totalmente\s+)?(?:corret[ao]|certo)/iu.test(message)
  ) {
    fail("objective_contradiction", "O feedback contradiz o resultado objetivo B16.");
  }
  if (
    validation.correct
    && /(?:consulta|query|resultado)\s+(?:está|é|foi)\s+(?:totalmente\s+)?(?:errad[ao]|incorret[ao])/iu.test(message)
  ) {
    fail("objective_contradiction", "O feedback contradiz o resultado objetivo B16.");
  }
}

function reconcilePedagogicalOutput(output, validation, evaluatedConcepts, knowledgeGraph) {
  try {
    validateOutputConcepts(output, evaluatedConcepts, knowledgeGraph);
    assertSafePedagogicalText(output);
    assertNoObjectiveContradiction(output, validation);
    return null;
  } catch (error) {
    return error;
  }
}

function solutionLeakCorrectionDirective() {
  return Object.freeze({
    role: "user",
    content: JSON.stringify({
      kind: "pedagogical_output_correction",
      rejection_code: "solution_leak",
      rules: [
        "Return a new answer without SQL code, query fragments, SELECT/FROM examples or a complete solution.",
        "Use only a Socratic question, conceptual feedback and graduated non-SQL hints.",
        "Keep the required JSON schema unchanged.",
      ],
    }),
  });
}

function validateOutputConcepts(output, evaluatedConcepts, knowledgeGraph) {
  const allowed = new Set(evaluatedConcepts);
  const pedagogical = output.pedagogical_assessment;
  const referenced = [
    ...pedagogical.conceptual_errors.map((item) => item.concept),
    ...pedagogical.misconceptions.map((item) => item.concept),
    ...pedagogical.positive_evidence.map((item) => item.concept),
    ...pedagogical.negative_evidence.map((item) => item.concept),
    ...output.mastery_evidence.map((item) => item.concept),
  ];
  if (referenced.some((concept) => !allowed.has(concept))) {
    fail("concept_override", "A LLM referenciou conceito fora dos conceitos avaliados.");
  }
  const masteryConcepts = output.mastery_evidence.map((item) => item.concept);
  if (new Set(masteryConcepts).size !== masteryConcepts.length) {
    fail("duplicate_mastery_evidence", "A LLM repetiu mastery evidence para um conceito.");
  }
  const errorCodes = pedagogical.conceptual_errors.map((item) => item.code);
  if (new Set(errorCodes).size !== errorCodes.length) {
    fail("duplicate_conceptual_error", "A LLM repetiu código de erro conceitual.");
  }

  const legitimatePrerequisites = new Set(evaluatedConcepts.flatMap((concept) => (
    knowledgeGraph.getTransitivePrerequisites(concept).map((node) => node.id)
  )));
  if (pedagogical.prerequisites_to_revisit.some(
    (concept) => !legitimatePrerequisites.has(concept),
  )) {
    fail("prerequisite_override", "A LLM sugeriu prerequisite sem relação no grafo.");
  }
}

function addLlmEvidence({
  target,
  suggestions,
  attempt,
  timestamp,
  polarity,
  startOrdinal,
}) {
  suggestions.forEach((item, index) => {
    target.push(evidence({
      attempt,
      timestamp,
      source: item.source,
      description: item.description,
      details: { concept: item.concept, origin: "llm_suggestion" },
      polarity,
      ordinal: startOrdinal + index,
    }));
  });
}

function normalizeUnderstanding(output, validation) {
  if (TECHNICAL_STATUSES.has(validation.status)) {
    return { understanding: "unknown", reasoning_quality: "unclear" };
  }
  let understanding = output.pedagogical_assessment.understanding;
  let quality = output.pedagogical_assessment.reasoning_quality;
  if (validation.correct && understanding === "insufficient") understanding = "partial";
  if (!validation.correct && understanding === "demonstrated") {
    understanding = validation.constraints.some((item) => item.passed)
      ? "partial"
      : "insufficient";
  }
  if (!validation.correct && quality === "strong" && understanding === "insufficient") {
    quality = "unclear";
  }
  return { understanding, reasoning_quality: quality };
}

function normalizeMasteryEvidence({ output, validation, evaluatedConcepts, attempt, timestamp }) {
  if (TECHNICAL_STATUSES.has(validation.status)) return [];
  const cap = objectiveStrengthCap(validation);
  const hasPositiveStructure = validation.constraints.some((item) => item.passed);
  const accepted = [];
  for (const suggestion of output.mastery_evidence) {
    if (validation.correct && suggestion.direction !== "up") continue;
    if (!validation.correct && suggestion.direction === "up" && !hasPositiveStructure) continue;
    const strength = suggestion.direction === "up" && !validation.correct
      ? "weak"
      : capStrength(suggestion.strength, cap);
    accepted.push({
      id: stableId("mastery-evidence", attempt.id, suggestion.concept),
      attempt_id: attempt.id,
      concept: suggestion.concept,
      direction: suggestion.direction,
      strength,
      reason: suggestion.reason,
      observed_at: timestamp,
    });
  }

  if (accepted.length === 0) {
    const direction = validation.correct ? "up" : "down";
    const strength = validation.status === "constraint_violation" ? "medium" : "weak";
    for (const concept of evaluatedConcepts) {
      accepted.push({
        id: stableId("mastery-evidence", attempt.id, concept),
        attempt_id: attempt.id,
        concept,
        direction,
        strength,
        reason: validation.correct
          ? "B16 confirmou o resultado; a evidência permanece conservadora sem histórico adicional."
          : `B16 registrou ${validation.status}; a evidência negativa é limitada aos fatos observados.`,
        observed_at: timestamp,
      });
    }
  }
  return accepted;
}

function normalizeSuggestedAction(output, validation, hasConceptualError, hasMisconception) {
  if (TECHNICAL_STATUSES.has(validation.status)) return "retry";
  const suggested = output.suggested_next_action;
  if (validation.correct) {
    return ["advance", "practice", "review"].includes(suggested)
      ? suggested
      : "practice";
  }
  if (hasConceptualError || hasMisconception) {
    return ["reteach", "practice", "review"].includes(suggested)
      ? suggested
      : "practice";
  }
  return suggested === "advance" ? "practice" : suggested;
}

function fallbackAction(validation) {
  if (TECHNICAL_STATUSES.has(validation.status)) return "retry";
  if (validation.correct) return "practice";
  if (validation.status === "constraint_violation") return "reteach";
  return "practice";
}

function fallbackFeedback(validation) {
  const responses = {
    correct: {
      message: "O resultado objetivo foi validado. A força pedagógica será tratada de forma conservadora.",
      hints: [],
    },
    incorrect_result: {
      message: "O resultado não corresponde ao esperado. Compare primeiro quais linhas deveriam ser incluídas.",
      hints: ["Revise as condições que determinam a inclusão de cada linha."],
    },
    wrong_columns: {
      message: "As colunas retornadas não correspondem ao contrato do exercício.",
      hints: ["Confira nomes, aliases e a ordem das colunas solicitadas."],
    },
    wrong_row_count: {
      message: "A quantidade de linhas retornada diverge do esperado.",
      hints: ["Investigue filtros, cardinalidade e possíveis duplicações."],
    },
    ordering_mismatch: {
      message: "O conteúdo foi encontrado, mas a ordenação exigida não foi preservada.",
      hints: ["Revise os critérios e a precedência da ordenação solicitada."],
    },
    constraint_violation: {
      message: "O resultado pode coincidir, mas uma propriedade obrigatória da solução não foi demonstrada.",
      hints: ["Releia qual conceito estrutural o exercício pretende avaliar."],
    },
    execution_error: {
      message: executionCategory(validation) === "syntax_error"
        ? "A consulta contém um erro de sintaxe. Revise sua estrutura antes da nova tentativa."
        : "A consulta não foi executada com sucesso. Revise o erro técnico antes da nova tentativa.",
      hints: ["Isole a menor parte da consulta que ainda reproduz o erro."],
    },
    security_violation: {
      message: "A consulta foi recusada pela política de segurança do sandbox.",
      hints: ["Use somente a operação de leitura prevista pelo exercício."],
    },
    timeout: {
      message: "A consulta excedeu o tempo máximo permitido.",
      hints: ["Reduza o trabalho desnecessário da consulta antes de tentar novamente."],
    },
    reference_validation_error: {
      message: "A tentativa não pôde ser avaliada por uma falha interna do exercício.",
      hints: [],
    },
  };
  return responses[validation.status];
}

function fallbackPedagogy(validation, error) {
  const structural = validation.status === "constraint_violation";
  return {
    source: "deterministic_fallback",
    understanding: structural ? "insufficient" : "unknown",
    reasoning_quality: "unclear",
    summary: validation.correct
      ? "Sucesso objetivo preservado; interpretação pedagógica indisponível."
      : `Fato objetivo ${validation.status} preservado; interpretação pedagógica indisponível.`,
    llm_error: error,
  };
}

function publicLlmError(error, fallback = {}) {
  return Object.freeze({
    category: typeof error?.category === "string"
      ? error.category
      : fallback.category ?? "provider_error",
    code: typeof error?.code === "string"
      ? error.code
      : fallback.code ?? "evaluator_llm_failure",
    message: fallback.message ?? "A análise pedagógica da LLM não ficou disponível.",
  });
}

function reconciliationError(error) {
  return publicLlmError(null, {
    category: "invalid_response",
    code: error instanceof EvaluatorValidationError
      ? error.code
      : "evaluator_reconciliation_failed",
    message: "A saída pedagógica foi rejeitada pela política do Evaluator.",
  });
}

function deterministicPedagogy(validation, source, normalized = null, llmError = null) {
  if (source === "deterministic_fallback") return fallbackPedagogy(validation, llmError);
  const statusSummary = validation.correct
    ? "A solução obteve sucesso objetivo; a força pedagógica foi reconciliada com as evidências estruturais."
    : `A interpretação pedagógica foi limitada pelo status objetivo ${validation.status}.`;
  return {
    source: "llm",
    understanding: normalized.understanding,
    reasoning_quality: normalized.reasoning_quality,
    summary: statusSummary,
    llm_error: null,
  };
}

function buildEvaluationResult({
  exercise,
  attempt,
  validation,
  evaluatedConcepts,
  output,
  source,
  llmError,
  llmRequestId,
  tutorPolicyVersion,
  timestamp,
}) {
  const objective = objectiveEvidence(validation, attempt, timestamp);
  let positiveEvidence = [...objective.positive];
  let negativeEvidence = [...objective.negative];
  const technical = TECHNICAL_STATUSES.has(validation.status);
  const deterministicErrors = deterministicConceptualErrors(validation, evaluatedConcepts);
  let conceptualErrors = deterministicErrors;
  let misconceptions = [];
  let prerequisites = [];
  let feedback;
  let normalized = { understanding: "unknown", reasoning_quality: "unclear" };

  if (source === "llm") {
    normalized = normalizeUnderstanding(output, validation);
    if (!technical && !validation.correct) {
      const existingCodes = new Set(deterministicErrors.map((item) => item.code));
      conceptualErrors = [
        ...deterministicErrors,
        ...output.pedagogical_assessment.conceptual_errors.filter((item) => {
          if (existingCodes.has(item.code)) return false;
          existingCodes.add(item.code);
          return true;
        }),
      ];
      prerequisites = output.pedagogical_assessment.prerequisites_to_revisit;
      addLlmEvidence({
        target: positiveEvidence,
        suggestions: output.pedagogical_assessment.positive_evidence,
        attempt,
        timestamp,
        polarity: "positive",
        startOrdinal: positiveEvidence.length + 100,
      });
      addLlmEvidence({
        target: negativeEvidence,
        suggestions: output.pedagogical_assessment.negative_evidence,
        attempt,
        timestamp,
        polarity: "negative",
        startOrdinal: negativeEvidence.length + 100,
      });
      misconceptions = output.pedagogical_assessment.misconceptions.map((item, index) => {
        const linkedEvidence = evidence({
          attempt,
          timestamp,
          source: "validation",
          description: item.evidence,
          details: { concept: item.concept, origin: "llm_suggestion" },
          polarity: "negative",
          ordinal: negativeEvidence.length + 200 + index,
        });
        negativeEvidence.push(linkedEvidence);
        return {
          id: stableId("misconception", attempt.id, item.concept, item.description),
          concept: item.concept,
          description: item.description,
          status: item.status,
          evidence_ids: [linkedEvidence.id],
          observed_at: timestamp,
        };
      });
    } else if (!technical && validation.correct) {
      addLlmEvidence({
        target: positiveEvidence,
        suggestions: output.pedagogical_assessment.positive_evidence,
        attempt,
        timestamp,
        polarity: "positive",
        startOrdinal: positiveEvidence.length + 100,
      });
    }
    feedback = {
      message_to_learner: output.feedback.message_to_learner,
      hints: output.feedback.hints.slice(0, 3),
    };
  } else {
    feedback = {
      message_to_learner: fallbackFeedback(validation).message,
      hints: fallbackFeedback(validation).hints,
    };
  }

  const syntheticOutput = source === "llm" ? output : {
    mastery_evidence: [],
    suggested_next_action: fallbackAction(validation),
  };
  const masteryEvidence = normalizeMasteryEvidence({
    output: syntheticOutput,
    validation,
    evaluatedConcepts,
    attempt,
    timestamp,
  });
  const suggestedAction = source === "llm"
    ? normalizeSuggestedAction(
      output,
      validation,
      conceptualErrors.length > 0,
      misconceptions.length > 0,
    )
    : fallbackAction(validation);
  const executionError = executionErrorFor(validation);
  const evaluation = createEvaluation({
    id: stableId("evaluation", attempt.id, validation.validator_policy_version),
    attempt_id: attempt.id,
    exercise_id: exercise.id,
    assessment: {
      correct: validation.correct,
      execution_error: executionError,
      conceptual_errors: conceptualErrors,
      misconceptions,
      positive_evidence: positiveEvidence,
      negative_evidence: negativeEvidence,
      prerequisites_to_revisit: prerequisites,
    },
    feedback,
    mastery_evidence: masteryEvidence,
    next_action: suggestedAction,
    evaluated_at: timestamp,
  }, "EvaluatorResult.evaluation");

  return createEvaluatorResult({
    evaluation,
    objective_assessment: objectiveAssessment(validation),
    pedagogical_assessment: deterministicPedagogy(
      validation,
      source,
      normalized,
      llmError,
    ),
    execution_error: evaluation.assessment.execution_error,
    conceptual_errors: evaluation.assessment.conceptual_errors,
    misconceptions: evaluation.assessment.misconceptions,
    evidence: {
      positive: evaluation.assessment.positive_evidence,
      negative: evaluation.assessment.negative_evidence,
    },
    feedback: evaluation.feedback.message_to_learner,
    hints: evaluation.feedback.hints,
    mastery_evidence: evaluation.mastery_evidence,
    suggested_next_action: evaluation.next_action,
    provenance: {
      exercise_id: exercise.id,
      attempt_id: attempt.id,
      validator_policy_version: validation.validator_policy_version,
      tutor_policy_version: tutorPolicyVersion,
      evaluator_policy_version: EVALUATOR_POLICY_VERSION,
      llm_request_id: llmRequestId,
    },
    evaluator_policy_version: EVALUATOR_POLICY_VERSION,
  });
}

export class EvaluatorService {
  #adapter;
  #policyBuilder;
  #knowledgeGraph;
  #clock;

  constructor({
    adapter,
    policyBuilder,
    knowledgeGraph = SQL_KNOWLEDGE_GRAPH,
    clock = () => new Date().toISOString(),
  }) {
    if (!adapter || typeof adapter.generate !== "function") {
      throw new TypeError("EvaluatorService requer o LLM Adapter B11.");
    }
    if (!policyBuilder || typeof policyBuilder.build !== "function") {
      throw new TypeError("EvaluatorService requer o context builder da Tutor Policy B12.");
    }
    if (
      !knowledgeGraph
      || typeof knowledgeGraph.getConcept !== "function"
      || typeof knowledgeGraph.getTransitivePrerequisites !== "function"
    ) {
      throw new TypeError("EvaluatorService requer o Knowledge Graph B09.");
    }
    if (typeof clock !== "function") throw new TypeError("clock deve ser função.");
    this.#adapter = adapter;
    this.#policyBuilder = policyBuilder;
    this.#knowledgeGraph = knowledgeGraph;
    this.#clock = clock;
    Object.freeze(this);
  }

  async evaluate(input) {
    const value = record(input, "EvaluatorInput");
    exactKeys(value, INPUT_KEYS, "EvaluatorInput");
    const exercise = normalizeExercise(value.exercise);
    const attempt = normalizeAttempt(value.attempt);
    const validation = assertResultValidation(value.validationResult);
    const learnerState = normalizeLearnerState(value.learnerState);
    const evaluatedConcepts = strings(
      value.evaluatedConcepts,
      "EvaluatorInput.evaluatedConcepts",
      { min: 1 },
    );
    if (attempt.exercise_id !== exercise.id) {
      fail("exercise_mismatch", "attempt.exercise_id difere de exercise.id.");
    }
    if (!sameValues(evaluatedConcepts, exercise.concepts)) {
      fail(
        "concept_mismatch",
        "evaluatedConcepts deve corresponder aos conceitos trusted do exercício.",
      );
    }
    try {
      evaluatedConcepts.forEach((concept) => this.#knowledgeGraph.getConcept(concept));
    } catch (error) {
      if (error instanceof UnknownKnowledgeConceptError) {
        fail("unknown_concept", "Um conceito avaliado não existe no Knowledge Graph.");
      }
      throw error;
    }
    const timestamp = nowFrom(this.#clock);
    const policyRequest = this.#policyBuilder.build({
      phase: "EVALUATE",
      learningGoal: learnerState.learning_goal,
      relevantConcepts: evaluatedConcepts,
      learnerState,
      knowledgeGraph: this.#knowledgeGraph,
      currentExercise: exercise,
      attempt,
      executionEvidence: publicExecutionEvidence(validation),
      recentMessages: value.recentMessages ?? [],
      tools: [],
    });
    const directive = {
      role: "user",
      content: JSON.stringify(authoritativeDirective(validation)),
    };
    const request = {
      instructions: evaluatorInstructions(policyRequest.instructions),
      messages: [policyRequest.messages[0], directive, ...policyRequest.messages.slice(1)],
      outputSchema: EVALUATOR_LLM_OUTPUT_SCHEMA,
      tools: [],
    };
    const serializedContext = JSON.stringify(request.messages);
    if (/reference_(?:query|solution)/iu.test(serializedContext)) {
      fail("reference_leak", "O contexto do Evaluator contém solução de referência.");
    }

    let llmResult = await this.#adapter.generate(request);
    if (llmResult.status !== "ok") {
      return buildEvaluationResult({
        exercise,
        attempt,
        validation,
        evaluatedConcepts,
        output: null,
        source: "deterministic_fallback",
        llmError: publicLlmError(llmResult.error),
        llmRequestId: llmResult.request_id,
        tutorPolicyVersion: this.#policyBuilder.policyVersion,
        timestamp,
      });
    }

    let reconciliation = reconcilePedagogicalOutput(
      llmResult.output,
      validation,
      evaluatedConcepts,
      this.#knowledgeGraph,
    );
    if (reconciliation instanceof EvaluatorValidationError && reconciliation.code === "solution_leak") {
      llmResult = await this.#adapter.generate({
        ...request,
        messages: [...request.messages, solutionLeakCorrectionDirective()],
      });
      if (llmResult.status !== "ok") {
        return buildEvaluationResult({
          exercise,
          attempt,
          validation,
          evaluatedConcepts,
          output: null,
          source: "deterministic_fallback",
          llmError: publicLlmError(llmResult.error),
          llmRequestId: llmResult.request_id,
          tutorPolicyVersion: this.#policyBuilder.policyVersion,
          timestamp,
        });
      }
      reconciliation = reconcilePedagogicalOutput(
        llmResult.output,
        validation,
        evaluatedConcepts,
        this.#knowledgeGraph,
      );
    }

    if (reconciliation === null) {
      return buildEvaluationResult({
        exercise,
        attempt,
        validation,
        evaluatedConcepts,
        output: llmResult.output,
        source: "llm",
        llmError: null,
        llmRequestId: llmResult.request_id,
        tutorPolicyVersion: this.#policyBuilder.policyVersion,
        timestamp,
      });
    }
    return buildEvaluationResult({
      exercise,
      attempt,
      validation,
      evaluatedConcepts,
      output: null,
      source: "deterministic_fallback",
      llmError: reconciliationError(reconciliation),
      llmRequestId: llmResult.request_id,
      tutorPolicyVersion: this.#policyBuilder.policyVersion,
      timestamp,
    });
  }
}

export async function createEvaluatorService(options = {}) {
  const policyBuilder = options.policyBuilder ?? await createTutorPolicyContextBuilder();
  return new EvaluatorService({ ...options, policyBuilder });
}

export { ADAPTIVE_ACTIONS };
