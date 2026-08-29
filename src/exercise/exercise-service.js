import { createAdaptiveDecision } from "../adaptive-decision/index.js";
import { KnowledgeGraph, SQL_KNOWLEDGE_GRAPH } from "../knowledge-graph/index.js";
import {
  DEFAULT_EDUCATION_SCHEMA,
  SqlPolicy,
  SqlPolicyError,
} from "../sandbox/sql-policy.js";
import {
  assertSupportedConstraints,
} from "../result-validator/constraints.js";
import { ResultValidatorConfigurationError } from "../result-validator/contracts.js";
import { createTutorPolicyContextBuilder } from "../tutor-policy/index.js";
import {
  EXERCISE_DIFFICULTY_TARGETS,
  EXERCISE_POLICY_VERSION,
  ExerciseValidationError,
  assertLearnerState,
  createExerciseGenerationResult,
  createGeneratedExercise,
} from "./contracts.js";
import { EXERCISE_GENERATION_OUTPUT_SCHEMA } from "./schemas.js";

const EXERCISE_PHASES = Object.freeze([
  "PRACTICE",
  "REVIEW",
  "APPLY",
  "TRANSFER_TEST",
]);

const DIFFICULTY_TARGET_VALUES = Object.freeze({
  low: 1,
  medium: 3,
  high: 5,
});

const REGENERABLE_LLM_ERRORS = new Set([
  "invalid_response",
  "schema_validation_error",
]);

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "connectionstring",
  "databaseurl",
  "credentials",
  "accesstoken",
  "refreshtoken",
]);

const SENSITIVE_VALUES = Object.freeze([
  /postgres(?:ql)?:\/\/[^\s]+/iu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/iu,
]);

function fail(code, message) {
  throw new ExerciseValidationError(code, message);
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

function exactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unknown_field", `${path}.${key} não é permitido.`);
    }
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_value", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail("invalid_value", `${path} deve ser um de: ${allowed.join(", ")}.`);
  }
  return value;
}

function strings(value, path) {
  if (!Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um array.`);
  }
  const normalized = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("duplicate_value", `${path} não deve conter valores duplicados.`);
  }
  return Object.freeze(normalized);
}

function jsonClone(value, path) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail("invalid_json", `${path} deve ser serializável como JSON.`);
  }
}

function assertNoSensitiveData(value, path = "pedagogicalContext") {
  if (typeof value === "string") {
    if (SENSITIVE_VALUES.some((pattern) => pattern.test(value))) {
      fail("sensitive_context", `${path} contém dado sensível não permitido.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveData(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
      if (SENSITIVE_KEYS.has(normalized)) {
        fail("sensitive_context", `${path}.${key} não é permitido.`);
      }
      assertNoSensitiveData(item, `${path}.${key}`);
    }
  }
}

function normalizeMessages(input, path) {
  if (input === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(input)) {
    fail("invalid_messages", `${path} deve ser um array.`);
  }
  return Object.freeze(input.map((item, index) => {
    const value = record(item, `${path}[${index}]`);
    exactKeys(value, ["role", "content"], `${path}[${index}]`);
    return Object.freeze({
      role: enumValue(value.role, ["user", "assistant"], `${path}[${index}].role`),
      content: requiredString(value.content, `${path}[${index}].content`),
    });
  }));
}

function normalizePedagogicalContext(input, learnerState) {
  const value = record(input, "pedagogicalContext");
  exactKeys(value, [
    "phase",
    "learning_goal",
    "integration_concepts",
    "scenario_hint",
    "recent_messages",
  ], "pedagogicalContext");
  const context = Object.freeze({
    phase: enumValue(value.phase, EXERCISE_PHASES, "pedagogicalContext.phase"),
    learning_goal: requiredString(
      value.learning_goal,
      "pedagogicalContext.learning_goal",
    ),
    integration_concepts: strings(
      value.integration_concepts ?? [],
      "pedagogicalContext.integration_concepts",
    ),
    scenario_hint: value.scenario_hint === null || value.scenario_hint === undefined
      ? null
      : requiredString(value.scenario_hint, "pedagogicalContext.scenario_hint"),
    recent_messages: normalizeMessages(
      value.recent_messages,
      "pedagogicalContext.recent_messages",
    ),
  });
  if (context.learning_goal !== learnerState.learning_goal) {
    fail(
      "learning_goal_mismatch",
      "pedagogicalContext.learning_goal deve corresponder ao LearnerState.",
    );
  }
  assertNoSensitiveData(context);
  return context;
}

function difficultyRange(conceptState) {
  if (conceptState.mastery < 0.5) {
    return { min: 1, max: 2 };
  }
  if (conceptState.mastery < 0.8) {
    return { min: 2, max: 4 };
  }
  if (conceptState.confidence === "low") {
    return { min: 3, max: 4 };
  }
  return { min: 4, max: 5 };
}

export function exerciseDifficultyFor({ conceptState, targetDifficulty }) {
  const target = enumValue(
    targetDifficulty,
    EXERCISE_DIFFICULTY_TARGETS,
    "targetDifficulty",
  );
  if (!conceptState || typeof conceptState !== "object") {
    fail("missing_concept_state", "conceptState é obrigatório para calcular difficulty.");
  }
  if (
    typeof conceptState.mastery !== "number"
    || !Number.isFinite(conceptState.mastery)
    || conceptState.mastery < 0
    || conceptState.mastery > 1
    || !["low", "medium", "high"].includes(conceptState.confidence)
  ) {
    fail("invalid_concept_state", "conceptState deve conter mastery e confidence válidos.");
  }
  const { min, max } = difficultyRange(conceptState);
  const requested = DIFFICULTY_TARGET_VALUES[target];
  return Math.max(min, Math.min(max, requested));
}

function sameValues(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertAdaptiveDecision(adaptiveDecisionInput, currentConcept) {
  if (adaptiveDecisionInput === undefined || adaptiveDecisionInput === null) {
    return null;
  }
  const decision = createAdaptiveDecision(adaptiveDecisionInput);
  if (["retry", "reteach"].includes(decision.action)) {
    fail(
      "decision_does_not_request_new_exercise",
      `A ação ${decision.action} não autoriza substituir automaticamente o exercício atual.`,
    );
  }
  const expectedConcept = decision.action === "advance"
    ? decision.next_concept
    : decision.current_concept;
  if (expectedConcept !== currentConcept) {
    fail(
      "adaptive_decision_mismatch",
      "currentConcept não corresponde ao conceito autorizado pela decisão B10.",
    );
  }
  return decision;
}

function assertGraphSelection({
  currentConcept,
  integrationConcepts,
  learnerState,
  knowledgeGraph,
}) {
  knowledgeGraph.getConcept(currentConcept);
  const currentState = learnerState.concepts.find((item) => item.concept === currentConcept);
  if (!currentState) {
    fail(
      "missing_concept_state",
      `LearnerState não contém o conceito atual: ${currentConcept}.`,
    );
  }
  const gaps = knowledgeGraph.getPrerequisiteGaps(currentConcept, learnerState);
  if (gaps.length > 0) {
    fail(
      "blocked_prerequisite",
      `O conceito ${currentConcept} possui pré-requisito não dominado.`,
    );
  }
  if (integrationConcepts.includes(currentConcept)) {
    fail("duplicate_target", "integration_concepts não deve repetir currentConcept.");
  }
  for (const concept of integrationConcepts) {
    knowledgeGraph.getConcept(concept);
    if (!knowledgeGraph.isOperationallyMastered(concept, learnerState)) {
      fail(
        "integration_concept_not_mastered",
        `O conceito de integração ${concept} ainda não possui domínio operacional.`,
      );
    }
  }
  return Object.freeze({
    currentState,
    targetConcepts: Object.freeze([currentConcept, ...integrationConcepts]),
  });
}

function normalizeLeakText(value) {
  return value
    .toLowerCase()
    .replaceAll(/```(?:sql)?/gu, " ")
    .replaceAll(/[^a-z0-9_]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function statementMentionsRelation(statement, relation) {
  const normalized = normalizeLeakText(statement);
  return normalized.includes(relation) || normalized.includes(relation.replaceAll("_", " "));
}

function assertNoSolutionLeak(statement, referenceQuery) {
  const normalizedStatement = normalizeLeakText(statement);
  const normalizedReference = normalizeLeakText(referenceQuery ?? "");
  if (normalizedReference.length > 0 && normalizedStatement.includes(normalizedReference)) {
    fail("reference_solution_leak", "O enunciado reproduz a query de referência.");
  }
  if (
    /(?:solu[cç][aã]o|resposta|reference[_ ]?solution)\s*:/iu.test(statement)
    && /\b(?:select|with)\b/iu.test(statement)
  ) {
    fail("reference_solution_leak", "O enunciado contém uma resposta SQL explícita.");
  }
}

function collectAllowedRelations(ast, allowedRelations) {
  const found = new Set();
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (
      value.type === "table"
      && typeof value.name?.name === "string"
      && allowedRelations.has(value.name.name)
    ) {
      found.add(value.name.name);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
  return [...found].sort();
}

function projectedColumnNames(ast) {
  if (!ast || typeof ast !== "object") return null;
  if (ast.type === "select") {
    if (!Array.isArray(ast.columns)) return null;
    const names = [];
    for (const column of ast.columns) {
      if (typeof column?.alias?.name === "string") {
        names.push(column.alias.name);
      } else if (column?.expr?.type === "ref" && typeof column.expr.name === "string") {
        names.push(column.expr.name);
      } else {
        return null;
      }
    }
    return names;
  }
  if (ast.type === "with" || ast.type === "with recursive") return projectedColumnNames(ast.in);
  if (ast.type === "union" || ast.type === "union all") return projectedColumnNames(ast.left);
  return null;
}

function assertReferenceQuery(metadata, sqlPolicy) {
  const referenceQuery = metadata.reference_query;
  const strategyNeedsReference = ["RESULT_SET", "ORDERED_RESULT"].includes(
    metadata.comparison_mode,
  );
  if (strategyNeedsReference && referenceQuery === null) {
    fail("missing_reference_query", "A estratégia exige reference_query interna.");
  }
  if (referenceQuery === null) {
    for (const relation of metadata.source_relations) {
      if (!sqlPolicy.allowedRelations.has(relation)) {
        fail("unknown_source_relation", `Relação não permitida: ${relation}.`);
      }
    }
    return;
  }

  let approved;
  try {
    approved = sqlPolicy.validate(referenceQuery);
  } catch (error) {
    if (error instanceof SqlPolicyError) {
      fail("unsafe_reference_query", "reference_query não atende à política read-only.");
    }
    throw error;
  }
  const actualRelations = collectAllowedRelations(approved.ast, sqlPolicy.allowedRelations);
  const declaredRelations = [...metadata.source_relations].sort();
  if (!sameValues(actualRelations, declaredRelations)) {
    fail(
      "source_relation_mismatch",
      "source_relations deve corresponder às relações usadas pela reference_query.",
    );
  }
  const projected = projectedColumnNames(approved.ast);
  if (projected !== null && !sameValues(projected, metadata.expected_columns)) {
    fail(
      "reference_columns_mismatch",
      "expected_columns deve corresponder às colunas projetadas pela reference_query.",
    );
  }
}

function assertMetadataConsistency({ generated, targetConcepts, knowledgeGraph, sqlPolicy }) {
  const { exercise, validation_metadata: metadata } = generated;
  if (!sameValues(exercise.concepts, targetConcepts)) {
    fail("target_override", "A LLM tentou alterar os conceitos-alvo autorizados.");
  }
  if (!sameValues(metadata.concepts_evaluated, targetConcepts)) {
    fail(
      "evaluated_concepts_mismatch",
      "concepts_evaluated deve corresponder aos conceitos-alvo.",
    );
  }
  if (exercise.validation_strategy !== metadata.comparison_mode) {
    fail(
      "comparison_mode_mismatch",
      "comparison_mode deve corresponder à validation_strategy.",
    );
  }
  const orderingExpected = exercise.validation_strategy === "ORDERED_RESULT";
  if (metadata.ordering_required !== orderingExpected) {
    fail(
      "ordering_mismatch",
      "ordering_required deve ser verdadeiro somente para ORDERED_RESULT.",
    );
  }

  const allowedSkills = new Set(targetConcepts);
  for (const concept of targetConcepts) {
    for (const prerequisite of knowledgeGraph.getTransitivePrerequisites(concept)) {
      allowedSkills.add(prerequisite.id);
    }
  }
  if (targetConcepts.some((concept) => !exercise.expected_skills.includes(concept))) {
    fail("missing_expected_skill", "expected_skills deve incluir cada conceito-alvo.");
  }
  if (exercise.expected_skills.some((skill) => !allowedSkills.has(skill))) {
    fail(
      "inconsistent_expected_skill",
      "expected_skills contém conceito fora dos alvos ou de seus pré-requisitos.",
    );
  }

  if (exercise.validation_strategy === "PROPERTY_BASED" && metadata.constraints.length === 0) {
    fail("insufficient_metadata", "PROPERTY_BASED exige ao menos uma constraint.");
  }
  if (exercise.validation_strategy === "PLAN_CONSTRAINT") {
    if (!targetConcepts.some((concept) => [
      "indexes",
      "explain",
      "query_optimization",
    ].includes(concept))) {
      fail(
        "plan_strategy_not_allowed",
        "PLAN_CONSTRAINT exige um conceito de plano ou otimização.",
      );
    }
    if (!metadata.constraints.some((constraint) => constraint.kind === "plan_property")) {
      fail("insufficient_metadata", "PLAN_CONSTRAINT exige uma constraint de plano.");
    }
  }
  assertSupportedConstraints(metadata.constraints, metadata.expected_columns);

  const serializedConstraints = metadata.constraints.map((item) => JSON.stringify(item));
  if (new Set(serializedConstraints).size !== serializedConstraints.length) {
    fail("duplicate_constraint", "validation_metadata possui constraints duplicadas.");
  }
  for (const relation of metadata.source_relations) {
    if (!statementMentionsRelation(exercise.statement, relation)) {
      fail(
        "ambiguous_statement",
        `O enunciado não identifica a relação ${relation}.`,
      );
    }
  }
  assertNoSolutionLeak(exercise.statement, metadata.reference_query);
  assertReferenceQuery(metadata, sqlPolicy);
}

function exerciseDirective({
  currentConcept,
  targetConcepts,
  difficulty,
  context,
  knowledgeGraph,
  adaptiveDecision,
  sqlPolicy,
}) {
  const relations = Object.fromEntries(
    [...sqlPolicy.allowedRelations]
      .sort()
      .filter((relation) => Object.hasOwn(DEFAULT_EDUCATION_SCHEMA, relation))
      .map((relation) => [relation, [...DEFAULT_EDUCATION_SCHEMA[relation]]]),
  );
  return Object.freeze({
    kind: "exercise_generation_directive",
    policy_version: EXERCISE_POLICY_VERSION,
    graph_version: knowledgeGraph.version,
    current_concept: currentConcept,
    target_concepts: [...targetConcepts],
    difficulty,
    pedagogical_phase: context.phase,
    scenario_hint: context.scenario_hint,
    adaptive_decision: adaptiveDecision === null
      ? null
      : {
        action: adaptiveDecision.action,
        current_concept: adaptiveDecision.current_concept,
        next_concept: adaptiveDecision.next_concept,
        policy_version: adaptiveDecision.policy_version,
      },
    available_schema: {
      name: sqlPolicy.allowedSchema,
      relations,
    },
    constraints: {
      generate_sql_exercise_only: true,
      use_exact_target_concepts: true,
      use_exact_difficulty: true,
      expected_skills_are_graph_concept_ids: true,
      do_not_include_reference_solution_field: true,
      reference_query_is_trusted_metadata_only: true,
      statement_must_not_contain_the_reference_query: true,
      do_not_execute_sql: true,
      use_only_available_schema_relations_and_columns: true,
    },
  });
}

function generationFailure({ attempts, category, code, message, retryable }) {
  return createExerciseGenerationResult({
    status: "error",
    exercise: null,
    validation_metadata: null,
    attempts,
    policy_version: EXERCISE_POLICY_VERSION,
    error: { category, code, message, retryable },
  });
}

function llmFailure(response, attempts) {
  return generationFailure({
    attempts,
    category: "llm_error",
    code: response.error?.code ?? "llm_generation_failed",
    message: "O provider não pôde gerar um exercício estruturado.",
    retryable: Boolean(response.error?.retryable),
  });
}

export class ExerciseService {
  #adapter;
  #policyBuilder;
  #knowledgeGraph;
  #sqlPolicy;
  #clock;
  #maxGenerationAttempts;

  constructor({
    adapter,
    policyBuilder,
    knowledgeGraph = SQL_KNOWLEDGE_GRAPH,
    sqlPolicy = new SqlPolicy(),
    clock = () => new Date().toISOString(),
    maxGenerationAttempts = 3,
  }) {
    if (!adapter || typeof adapter.generate !== "function") {
      throw new TypeError("ExerciseService requer o LLM Adapter B11.");
    }
    if (!policyBuilder || typeof policyBuilder.build !== "function") {
      throw new TypeError("ExerciseService requer o Tutor Policy builder B12.");
    }
    if (!(knowledgeGraph instanceof KnowledgeGraph)) {
      throw new TypeError("ExerciseService requer o Knowledge Graph B09.");
    }
    if (
      !sqlPolicy
      || typeof sqlPolicy.validate !== "function"
      || !(sqlPolicy.allowedRelations instanceof Set)
    ) {
      throw new TypeError("ExerciseService requer uma política SQL read-only.");
    }
    if (!Number.isSafeInteger(maxGenerationAttempts)
      || maxGenerationAttempts < 1
      || maxGenerationAttempts > 5) {
      throw new TypeError("maxGenerationAttempts deve ser inteiro entre 1 e 5.");
    }
    if (typeof clock !== "function") {
      throw new TypeError("clock deve ser uma função.");
    }
    this.#adapter = adapter;
    this.#policyBuilder = policyBuilder;
    this.#knowledgeGraph = knowledgeGraph;
    this.#sqlPolicy = sqlPolicy;
    this.#clock = clock;
    this.#maxGenerationAttempts = maxGenerationAttempts;
  }

  async generate(input) {
    const value = record(input, "ExerciseGenerationInput");
    exactKeys(value, [
      "currentConcept",
      "learnerState",
      "targetDifficulty",
      "pedagogicalContext",
      "adaptiveDecision",
    ], "ExerciseGenerationInput");
    const currentConcept = requiredString(value.currentConcept, "currentConcept");
    const learnerState = assertLearnerState(value.learnerState);
    const context = normalizePedagogicalContext(value.pedagogicalContext, learnerState);
    const adaptiveDecision = assertAdaptiveDecision(value.adaptiveDecision, currentConcept);
    const selection = assertGraphSelection({
      currentConcept,
      integrationConcepts: context.integration_concepts,
      learnerState,
      knowledgeGraph: this.#knowledgeGraph,
    });
    const difficulty = exerciseDifficultyFor({
      conceptState: selection.currentState,
      targetDifficulty: value.targetDifficulty,
    });
    const timestamp = this.#clock();
    const parsedTimestamp = typeof timestamp === "string" ? new Date(timestamp) : null;
    if (
      parsedTimestamp === null
      || Number.isNaN(parsedTimestamp.getTime())
      || parsedTimestamp.toISOString() !== timestamp
    ) {
      fail("invalid_clock", "clock deve retornar timestamp ISO-8601 UTC canônico.");
    }

    const baseRequest = this.#policyBuilder.build({
      phase: context.phase,
      learningGoal: context.learning_goal,
      relevantConcepts: selection.targetConcepts,
      learnerState,
      knowledgeGraph: this.#knowledgeGraph,
      recentMessages: context.recent_messages,
      tools: [],
    });
    const directive = exerciseDirective({
      currentConcept,
      targetConcepts: selection.targetConcepts,
      difficulty,
      context,
      knowledgeGraph: this.#knowledgeGraph,
      adaptiveDecision,
      sqlPolicy: this.#sqlPolicy,
    });
    const request = {
      ...baseRequest,
      instructions: [
        baseRequest.instructions,
        "",
        "## B15 exercise-generation contract",
        "Generate one exercise only. The application decides target concepts and difficulty.",
        "Return the reference query only inside trusted validation_metadata.",
        "Never copy the reference query or a complete solution into the learner statement.",
        "Do not execute SQL, evaluate a learner, update mastery or decide progression.",
      ].join("\n"),
      messages: [
        ...baseRequest.messages,
        { role: "user", content: JSON.stringify(directive) },
      ],
      outputSchema: EXERCISE_GENERATION_OUTPUT_SCHEMA,
      tools: [],
    };

    let lastValidationCode = "invalid_generated_exercise";
    for (let attempts = 1; attempts <= this.#maxGenerationAttempts; attempts += 1) {
      const attemptRequest = attempts === 1 ? request : {
        ...request,
        messages: [
          ...request.messages,
          {
            role: "user",
            content: JSON.stringify({
              kind: "exercise_generation_correction",
              rejected_code: lastValidationCode,
              instruction: "Generate a new exercise. Use only available_schema table and column names in validation_metadata.reference_query.",
            }),
          },
        ],
      };
      let response;
      try {
        response = await this.#adapter.generate(attemptRequest);
      } catch {
        return generationFailure({
          attempts,
          category: "llm_error",
          code: "llm_generation_failed",
          message: "O provider não pôde gerar um exercício estruturado.",
          retryable: false,
        });
      }
      if (response.status !== "ok") {
        if (
          REGENERABLE_LLM_ERRORS.has(response.error?.category)
          && attempts < this.#maxGenerationAttempts
        ) {
          lastValidationCode = "invalid_llm_output";
          continue;
        }
        if (REGENERABLE_LLM_ERRORS.has(response.error?.category)) {
          return generationFailure({
            attempts,
            category: "generation_error",
            code: "invalid_llm_output",
            message: "A LLM não produziu um exercício compatível com o schema B15.",
            retryable: false,
          });
        }
        return llmFailure(response, attempts);
      }

      try {
        const generated = createGeneratedExercise({
          ...jsonClone(response.output, "llm.output"),
          created_at: timestamp,
        });
        if (generated.exercise.difficulty !== difficulty) {
          fail("difficulty_override", "A LLM tentou alterar a difficulty determinada.");
        }
        assertMetadataConsistency({
          generated,
          targetConcepts: selection.targetConcepts,
          knowledgeGraph: this.#knowledgeGraph,
          sqlPolicy: this.#sqlPolicy,
        });
        return createExerciseGenerationResult({
          status: "ok",
          exercise: generated.exercise,
          validation_metadata: generated.validation_metadata,
          attempts,
          policy_version: EXERCISE_POLICY_VERSION,
          error: null,
        });
      } catch (error) {
        lastValidationCode = error instanceof ExerciseValidationError
          ? error.code
          : error instanceof ResultValidatorConfigurationError
            ? error.code
            : "invalid_generated_exercise";
        if (attempts === this.#maxGenerationAttempts) {
          return generationFailure({
            attempts,
            category: "generation_error",
            code: lastValidationCode,
            message: "O exercício gerado foi rejeitado pela validação determinística.",
            retryable: false,
          });
        }
      }
    }

    return generationFailure({
      attempts: this.#maxGenerationAttempts,
      category: "generation_error",
      code: lastValidationCode,
      message: "Não foi possível obter um exercício válido.",
      retryable: false,
    });
  }
}

export async function createExerciseService(options = {}) {
  const policyBuilder = options.policyBuilder ?? await createTutorPolicyContextBuilder();
  return new ExerciseService({ ...options, policyBuilder });
}
