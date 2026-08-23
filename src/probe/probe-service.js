import { createHash } from "node:crypto";

import {
  createConceptState,
  createEvaluation,
  createLearnerState,
  EXECUTION_ERROR_CATEGORIES,
} from "../domain/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../knowledge-graph/index.js";
import { LearnerModelService } from "../learner-model/index.js";
import { createTutorPolicyContextBuilder } from "../tutor-policy/index.js";
import {
  createProbeHistoryEntry,
  createProbeQuestion,
  createProbeSession,
  ProbeValidationError,
} from "./contracts.js";
import {
  buildProbeResult,
  decideProbeCompletion,
  nextProbeDifficulty,
  PROBE_DEFAULT_MAX_QUESTIONS,
  PROBE_POLICY_VERSION,
  probeQuestionTargets,
  probeQuestionType,
  resolveProbeTargets,
  selectInitialProbeConcept,
  selectNextProbeConcept,
} from "./probe-policy.js";
import {
  PROBE_EVALUATION_OUTPUT_SCHEMA,
  PROBE_QUESTION_OUTPUT_SCHEMA,
} from "./schemas.js";

function stableId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20);
  return `${prefix}:${digest}`;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProbeValidationError("invalid_input", `${path} deve ser uma string não vazia.`);
  }
  return value;
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
    throw new ProbeValidationError("invalid_clock", "clock deve retornar timestamp ISO canônico.");
  }
  return value;
}

function buildInitialLearnerState({ sessionId, learningGoal, concepts, timestamp }) {
  return createLearnerState({
    id: `learner-state:${sessionId}`,
    session_id: sessionId,
    learning_goal: learningGoal,
    concepts: concepts.map((concept) => createConceptState({
      id: `concept-state:${sessionId}:${concept}`,
      concept,
      mastery: 0.5,
      confidence: "low",
      misconceptions: [],
      evidence_ids: [],
      evidence_summary: {},
      created_at: timestamp,
      updated_at: timestamp,
    })),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function sanitizedLocalError(error) {
  if (error instanceof ProbeValidationError) {
    return Object.freeze({
      category: "invalid_response",
      code: error.code,
      message: "A resposta estruturada do diagnóstico violou a política do PROBE.",
    });
  }
  return Object.freeze({
    category: "provider_error",
    code: "probe_failure",
    message: "O diagnóstico não pôde concluir a operação com a LLM.",
  });
}

function errorSession(session, error, timestamp) {
  return createProbeSession({
    ...session,
    status: "error",
    completion_reason: "llm_failure",
    result: null,
    error: {
      category: error.category,
      code: error.code,
      message: error.message,
    },
    updated_at: timestamp,
  });
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertQuestionOutput(output, selection, targetPool) {
  if (output.difficulty !== selection.difficulty) {
    throw new ProbeValidationError("difficulty_override", "A LLM tentou alterar a dificuldade.");
  }
  if (output.question_type !== selection.questionType) {
    throw new ProbeValidationError("question_type_override", "A LLM tentou alterar o tipo.");
  }
  if (!sameValues(output.targets, targetPool)) {
    throw new ProbeValidationError("target_override", "A LLM tentou alterar os conceitos-alvo.");
  }
}

function assertEvaluationConcepts(output, allowedConcepts, knowledgeGraph, currentConcept) {
  const allowed = new Set(allowedConcepts);
  const evidenceConcepts = output.mastery_evidence.map((item) => item.concept);
  if (new Set(evidenceConcepts).size !== evidenceConcepts.length) {
    throw new ProbeValidationError(
      "duplicate_mastery_evidence",
      "A avaliação repetiu evidência para o mesmo conceito.",
    );
  }
  const assessedConcepts = [
    ...evidenceConcepts,
    ...output.assessment.conceptual_errors.map((item) => item.concept),
    ...output.assessment.misconceptions.map((item) => item.concept),
  ];
  if (assessedConcepts.some((concept) => !allowed.has(concept))) {
    throw new ProbeValidationError(
      "concept_override",
      "A avaliação referencia conceito fora da pergunta diagnóstica.",
    );
  }
  const legitimatePrerequisites = new Set(
    knowledgeGraph.getTransitivePrerequisites(currentConcept).map((node) => node.id),
  );
  if (output.assessment.prerequisites_to_revisit.some(
    (concept) => !legitimatePrerequisites.has(concept),
  )) {
    throw new ProbeValidationError(
      "prerequisite_override",
      "A avaliação sugeriu pré-requisito sem relação no Knowledge Graph.",
    );
  }
}

function normalizeExecutionEvidence(input) {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ProbeValidationError("invalid_execution_evidence", "executionEvidence inválida.");
  }
  const status = input.status;
  if (!["ok", "error"].includes(status)) {
    throw new ProbeValidationError("invalid_execution_evidence", "executionEvidence.status inválido.");
  }
  const columns = Array.isArray(input.columns) && input.columns.every((item) => typeof item === "string")
    ? [...input.columns]
    : null;
  let rows;
  try {
    rows = Array.isArray(input.rows) ? JSON.parse(JSON.stringify(input.rows)) : null;
  } catch {
    rows = null;
  }
  const rowCount = input.row_count ?? 0;
  const truncated = input.truncated ?? false;
  const durationMs = input.duration_ms ?? 0;
  if (
    columns === null
    || rows === null
    || !Number.isSafeInteger(rowCount)
    || rowCount < 0
    || typeof truncated !== "boolean"
    || typeof durationMs !== "number"
    || !Number.isFinite(durationMs)
    || durationMs < 0
  ) {
    throw new ProbeValidationError("invalid_execution_evidence", "executionEvidence inválida.");
  }
  let error = null;
  if (input.error !== null && input.error !== undefined) {
    const category = input.error?.category;
    const sqlstate = input.error?.sqlstate ?? null;
    if (
      !EXECUTION_ERROR_CATEGORIES.includes(category)
      || (sqlstate !== null && (typeof sqlstate !== "string" || !/^[0-9A-Z]{5}$/u.test(sqlstate)))
    ) {
      throw new ProbeValidationError("invalid_execution_evidence", "executionEvidence.error inválido.");
    }
    error = {
      category,
      sqlstate,
      message: "Erro de execução sanitizado pelo SQL Sandbox.",
    };
  }
  if ((status === "ok" && error !== null) || (status === "error" && error === null)) {
    throw new ProbeValidationError("invalid_execution_evidence", "executionEvidence incoerente.");
  }
  const evidence = {
    status,
    columns,
    rows,
    row_count: rowCount,
    truncated,
    duration_ms: durationMs,
    error,
  };
  return Object.freeze(evidence);
}

function evaluationFromOutput({ entry, output, executionEvidence, timestamp }) {
  const question = entry.question;
  const attemptId = `probe-attempt:${question.id}`;
  const evaluationId = `probe-evaluation:${question.id}`;
  const positiveEvidence = [];
  const negativeEvidence = [];
  const masteryEvidence = output.mastery_evidence.map((item, index) => {
    const id = `${evaluationId}:mastery:${index + 1}`;
    const evidenceDetail = {
      id: `${evaluationId}:${item.direction}:${index + 1}`,
      source: executionEvidence ? "execution" : "historical",
      description: item.reason,
      details: [
        { key: "probe_question_id", value: question.id },
        { key: "llm_suggested_strength", value: item.strength },
      ],
      observed_at: timestamp,
    };
    (item.direction === "up" ? positiveEvidence : negativeEvidence).push(evidenceDetail);
    return {
      id,
      attempt_id: attemptId,
      concept: item.concept,
      direction: item.direction,
      strength: item.strength,
      reason: item.reason,
      observed_at: timestamp,
    };
  });
  const misconceptionEvidenceIds = new Map();
  for (const [index, item] of output.assessment.misconceptions.entries()) {
    const id = `${evaluationId}:misconception:${index + 1}`;
    misconceptionEvidenceIds.set(item, id);
    negativeEvidence.push({
      id,
      source: executionEvidence ? "execution" : "historical",
      description: item.evidence,
      details: [{ key: "probe_question_id", value: question.id }],
      observed_at: timestamp,
    });
  }
  for (const [index, item] of output.assessment.conceptual_errors.entries()) {
    negativeEvidence.push({
      id: `${evaluationId}:conceptual-error:${index + 1}`,
      source: executionEvidence ? "execution" : "historical",
      description: item.description,
      details: [{ key: "probe_question_id", value: question.id }],
      observed_at: timestamp,
    });
  }
  const executionError = executionEvidence?.status === "error"
    ? executionEvidence.error
    : null;

  return createEvaluation({
    id: evaluationId,
    attempt_id: attemptId,
    exercise_id: `probe-exercise:${question.id}`,
    assessment: {
      correct: executionError === null && output.assessment.correct,
      execution_error: executionError,
      conceptual_errors: output.assessment.conceptual_errors,
      misconceptions: output.assessment.misconceptions.map((item) => ({
        id: stableId("misconception", item.concept, item.description),
        concept: item.concept,
        description: item.description,
        status: item.status,
        evidence_ids: [misconceptionEvidenceIds.get(item)],
        observed_at: timestamp,
      })),
      positive_evidence: positiveEvidence,
      negative_evidence: negativeEvidence,
      prerequisites_to_revisit: output.assessment.prerequisites_to_revisit,
    },
    feedback: {
      message_to_learner: "Resposta registrada para o diagnóstico; nenhuma solução foi revelada.",
      hints: [],
    },
    mastery_evidence: masteryEvidence,
    next_action: "continue_probe",
    evaluated_at: timestamp,
  });
}

function probeDirective(selection, targetPool, session) {
  return {
    kind: "probe_question_directive",
    policy_version: PROBE_POLICY_VERSION,
    question_number: session.question_count + 1,
    current_concept: selection.concept,
    targets: targetPool,
    difficulty: selection.difficulty,
    question_type: selection.questionType,
    intent: selection.intent,
    constraints: {
      ask_exactly_one_open_question: true,
      teach_or_reveal_answer: false,
      include_solution_hint_or_feedback: false,
    },
  };
}

export class ProbeService {
  #adapter;
  #policyBuilder;
  #knowledgeGraph;
  #learnerModel;
  #clock;

  constructor({
    adapter,
    policyBuilder,
    knowledgeGraph = SQL_KNOWLEDGE_GRAPH,
    learnerModel = new LearnerModelService(),
    clock = () => new Date().toISOString(),
  }) {
    if (!adapter || typeof adapter.generate !== "function") {
      throw new TypeError("ProbeService requer o LLM Adapter B11.");
    }
    if (!policyBuilder || typeof policyBuilder.build !== "function") {
      throw new TypeError("ProbeService requer o Tutor Policy builder B12.");
    }
    if (!knowledgeGraph || typeof knowledgeGraph.getConcepts !== "function") {
      throw new TypeError("ProbeService requer o Knowledge Graph B09.");
    }
    if (!learnerModel || typeof learnerModel.update !== "function") {
      throw new TypeError("ProbeService requer o Learner Model Service B08.");
    }
    this.#adapter = adapter;
    this.#policyBuilder = policyBuilder;
    this.#knowledgeGraph = knowledgeGraph;
    this.#learnerModel = learnerModel;
    this.#clock = clock;
  }

  async start({
    learningGoal,
    targetConcepts,
    maxQuestions = PROBE_DEFAULT_MAX_QUESTIONS,
    sessionId,
  }) {
    const goal = requiredString(learningGoal, "learningGoal");
    if (!Number.isSafeInteger(maxQuestions) || maxQuestions < 5 || maxQuestions > 12) {
      throw new ProbeValidationError(
        "invalid_max_questions",
        "maxQuestions deve ser inteiro entre 5 e 12.",
      );
    }
    const timestamp = nowFrom(this.#clock);
    const id = sessionId === undefined
      ? stableId("probe-session", goal, JSON.stringify(targetConcepts ?? []))
      : requiredString(sessionId, "sessionId");
    const targets = resolveProbeTargets({
      learningGoal: goal,
      requestedConcepts: targetConcepts,
      knowledgeGraph: this.#knowledgeGraph,
    });
    const initialConcept = selectInitialProbeConcept(targets, this.#knowledgeGraph);
    const session = {
      id,
      learning_goal: goal,
      primary_concepts: targets.primary_concepts,
      target_concepts: targets.target_concepts,
      evaluated_concepts: [],
      current_concept: null,
      current_difficulty: 3,
      question_count: 0,
      max_questions: maxQuestions,
      status: "active",
      learner_state: buildInitialLearnerState({
        sessionId: id,
        learningGoal: goal,
        concepts: targets.target_concepts,
        timestamp,
      }),
      history: [],
      completion_reason: null,
      result: null,
      error: null,
      policy_version: PROBE_POLICY_VERSION,
      created_at: timestamp,
      updated_at: timestamp,
    };
    return this.#generateQuestion(session, {
      concept: initialConcept,
      intent: "discriminative",
      difficulty: 3,
      questionType: probeQuestionType(1, "discriminative"),
    });
  }

  async submitAnswer(sessionInput, { answer, executionEvidence = null }) {
    const session = createProbeSession(sessionInput);
    if (session.status !== "active") {
      throw new ProbeValidationError("inactive_session", "A sessão PROBE não está ativa.");
    }
    const learnerAnswer = requiredString(answer, "answer");
    const objectiveEvidence = normalizeExecutionEvidence(executionEvidence);
    const entry = session.history.at(-1);
    const timestamp = nowFrom(this.#clock);

    let response;
    try {
      const baseRequest = this.#policyBuilder.build({
        phase: "PROBE",
        learningGoal: session.learning_goal,
        relevantConcepts: entry.question.targets,
        learnerState: session.learner_state,
        knowledgeGraph: this.#knowledgeGraph,
        recentMessages: [
          { role: "assistant", content: entry.question.question },
          { role: "user", content: learnerAnswer },
        ],
      });
      response = await this.#adapter.generate({
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          {
            role: "user",
            content: JSON.stringify({
              kind: "probe_evaluation_directive",
              policy_version: PROBE_POLICY_VERSION,
              question: {
                id: entry.question.id,
                concept: entry.question.concept,
                targets: entry.question.targets,
                difficulty: entry.question.difficulty,
                question_type: entry.question.question_type,
              },
              execution_evidence: objectiveEvidence,
              constraints: {
                assess_without_teaching: true,
                do_not_return_feedback_hint_or_solution: true,
                mastery_is_evidence_not_final_score: true,
                do_not_claim_execution_without_evidence: true,
              },
            }),
          },
        ],
        outputSchema: PROBE_EVALUATION_OUTPUT_SCHEMA,
        tools: [],
      });
    } catch (error) {
      return errorSession(session, sanitizedLocalError(error), timestamp);
    }
    if (response.status !== "ok") {
      return errorSession(session, response.error, timestamp);
    }

    let evaluation;
    let update;
    try {
      assertEvaluationConcepts(
        response.output,
        entry.question.targets,
        this.#knowledgeGraph,
        entry.question.concept,
      );
      evaluation = evaluationFromOutput({
        entry,
        output: response.output,
        executionEvidence: objectiveEvidence,
        timestamp,
      });
      update = this.#learnerModel.update(session.learner_state, evaluation);
    } catch (error) {
      return errorSession(session, sanitizedLocalError(error), timestamp);
    }

    const completedEntry = createProbeHistoryEntry({
      ...entry,
      answer: learnerAnswer,
      evaluation,
      mastery_changes: update.mastery_changes,
      answered_at: timestamp,
    });
    const evaluatedConcepts = [
      ...new Set([
        ...session.evaluated_concepts,
        ...evaluation.mastery_evidence.map((item) => item.concept),
        ...evaluation.assessment.conceptual_errors.map((item) => item.concept),
        ...evaluation.assessment.misconceptions.map((item) => item.concept),
      ]),
    ].filter((concept) => session.target_concepts.includes(concept));
    const answeredSession = {
      ...session,
      learner_state: update.learner_state,
      evaluated_concepts: session.target_concepts.filter(
        (concept) => evaluatedConcepts.includes(concept),
      ),
      current_concept: entry.question.concept,
      history: [...session.history.slice(0, -1), completedEntry],
      updated_at: timestamp,
    };
    const completionReason = decideProbeCompletion(answeredSession, this.#knowledgeGraph);
    if (completionReason !== null) {
      const result = buildProbeResult(answeredSession, this.#knowledgeGraph, completionReason);
      return createProbeSession({
        ...answeredSession,
        status: "completed",
        current_concept: null,
        completion_reason: completionReason,
        result,
      });
    }

    const next = selectNextProbeConcept(answeredSession, this.#knowledgeGraph);
    const difficulty = nextProbeDifficulty(answeredSession, next.intent);
    return this.#generateQuestion(answeredSession, {
      ...next,
      difficulty,
      questionType: probeQuestionType(answeredSession.question_count + 1, next.intent),
    });
  }

  async #generateQuestion(session, selection) {
    const timestamp = nowFrom(this.#clock);
    const targetPool = probeQuestionTargets(selection.concept, this.#knowledgeGraph)
      .filter((concept) => session.target_concepts.includes(concept));
    let response;
    try {
      const baseRequest = this.#policyBuilder.build({
        phase: "PROBE",
        learningGoal: session.learning_goal,
        relevantConcepts: targetPool,
        learnerState: session.learner_state,
        knowledgeGraph: this.#knowledgeGraph,
        recentMessages: [],
      });
      response = await this.#adapter.generate({
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          {
            role: "user",
            content: JSON.stringify(probeDirective(selection, targetPool, session)),
          },
        ],
        outputSchema: PROBE_QUESTION_OUTPUT_SCHEMA,
        tools: [],
      });
    } catch (error) {
      return errorSession(session, sanitizedLocalError(error), timestamp);
    }
    if (response.status !== "ok") {
      return errorSession(session, response.error, timestamp);
    }

    try {
      assertQuestionOutput(response.output, selection, targetPool);
      const questionNumber = session.question_count + 1;
      const question = createProbeQuestion({
        id: `probe-question:${session.id}:${questionNumber}`,
        concept: selection.concept,
        targets: response.output.targets,
        question_type: response.output.question_type,
        intent: selection.intent,
        difficulty: response.output.difficulty,
        question: response.output.question,
        reason: response.output.reason,
        created_at: timestamp,
      });
      const historyEntry = createProbeHistoryEntry({
        id: `probe-history:${session.id}:${questionNumber}`,
        question,
        answer: null,
        evaluation: null,
        mastery_changes: [],
        answered_at: null,
      });
      return createProbeSession({
        ...session,
        current_concept: selection.concept,
        current_difficulty: selection.difficulty,
        question_count: questionNumber,
        history: [...session.history, historyEntry],
        updated_at: timestamp,
      });
    } catch (error) {
      return errorSession(session, sanitizedLocalError(error), timestamp);
    }
  }
}

export async function createProbeService(options = {}) {
  const policyBuilder = options.policyBuilder ?? await createTutorPolicyContextBuilder();
  return new ProbeService({ ...options, policyBuilder });
}
