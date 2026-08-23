import { createHash } from "node:crypto";

import { createAttempt } from "../domain/index.js";
import { toLearnerExercise } from "../exercise/index.js";
import { classifyMastery } from "../learner-model/index.js";
import {
  TERMINAL_APPLICATION_POLICY_VERSION,
  TutorApplicationValidationError,
  createApplicationEvent,
  createApplicationResult,
  createTrustedCurrentExercise,
  createTutorApplicationSession,
} from "./contracts.js";

const EXITABLE_SESSION_STATUSES = new Set(["active", "error"]);

function fail(code, message) {
  throw new TutorApplicationValidationError(code, message);
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_input", `${path} deve ser uma string não vazia.`);
  }
  return value.trim();
}

function timestamp(clock) {
  const value = clock();
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("invalid_clock", "clock deve retornar timestamp ISO-8601 canônico.");
  }
  return value;
}

function stableId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  return `${prefix}:${digest}`;
}

function publicError(error, fallback = {}) {
  return Object.freeze({
    category: typeof error?.category === "string"
      ? error.category
      : fallback.category ?? "application_error",
    code: typeof error?.code === "string"
      ? error.code
      : fallback.code ?? "operation_failed",
    message: fallback.message ?? "A operação não pôde ser concluída.",
    retryable: typeof error?.retryable === "boolean"
      ? error.retryable
      : Boolean(fallback.retryable),
  });
}

function probeQuestionEvent(probe) {
  const current = probe.history.at(-1)?.question;
  if (!current) fail("missing_probe_question", "PROBE ativo sem pergunta atual.");
  return createApplicationEvent("probe_question", {
    number: probe.question_count,
    max_questions: probe.max_questions,
    concept: current.concept,
    difficulty: current.difficulty,
    question_type: current.question_type,
    question: current.question,
  });
}

function probeCompletedEvent(probe) {
  return createApplicationEvent("probe_completed", {
    evaluated_concepts: probe.result.evaluated_concepts,
    mastered_concepts: probe.result.mastered_concepts,
    partial_concepts: probe.result.partial_concepts,
    gaps: probe.result.gaps,
    confidence: probe.result.confidence,
    misconceptions: probe.result.misconceptions,
    next_concept_recommended: probe.result.next_concept_recommended,
    completion_reason: probe.result.completion_reason,
  });
}

function progressEvent(learnerState, currentConcept) {
  const concepts = learnerState.concepts.map((state) => ({
    concept: state.concept,
    mastery: state.mastery,
    confidence: state.confidence,
    classification: classifyMastery(state.mastery),
    active_misconceptions: state.misconceptions.filter(
      (item) => item.status !== "resolved",
    ).length,
  }));
  return createApplicationEvent("progress", {
    current_concept: currentConcept,
    concepts,
  });
}

function publicExerciseEvent(currentExercise, { reused = false } = {}) {
  const exercise = toLearnerExercise(currentExercise.exercise);
  return createApplicationEvent("exercise", {
    id: exercise.id,
    concepts: exercise.concepts,
    objective: exercise.objective,
    statement: exercise.statement,
    difficulty: exercise.difficulty,
    expected_skills: exercise.expected_skills,
    validation_strategy: exercise.validation_strategy,
    reused,
  });
}

function executionEvent(validation, evaluation) {
  if (validation.execution === null) {
    return createApplicationEvent("execution", {
      status: validation.status,
      columns: [],
      rows: [],
      row_count: 0,
      truncated: false,
      duration_ms: 0,
      error: evaluation.execution_error ?? {
        category: "execution_error",
        sqlstate: null,
        message: "A tentativa não pôde ser executada ou validada.",
      },
    });
  }
  return createApplicationEvent("execution", {
    status: validation.status,
    columns: validation.execution.columns,
    rows: validation.execution.rows,
    row_count: validation.execution.row_count,
    truncated: validation.execution.truncated,
    duration_ms: validation.execution.duration_ms,
    error: evaluation.execution_error,
  });
}

function feedbackEvent(evaluatorResult) {
  return createApplicationEvent("feedback", {
    correct: evaluatorResult.objective_assessment.correct,
    message: evaluatorResult.feedback,
    hints: evaluatorResult.hints,
    conceptual_errors: evaluatorResult.conceptual_errors.map((item) => ({
      code: item.code,
      concept: item.concept,
      description: item.description,
    })),
    misconceptions: evaluatorResult.misconceptions.map((item) => ({
      concept: item.concept,
      description: item.description,
      status: item.status,
    })),
    source: evaluatorResult.pedagogical_assessment.source,
  });
}

function decisionEvent(decision) {
  return createApplicationEvent("decision", {
    action: decision.action,
    current_concept: decision.current_concept,
    next_concept: decision.next_concept,
    reason_codes: decision.reason_codes,
    rationale: decision.rationale,
    policy_version: decision.policy_version,
  });
}

function exerciseAdaptiveDecision(session) {
  if (session.last_decision === null) return null;
  return ["retry", "reteach"].includes(session.last_decision.action)
    ? null
    : session.last_decision;
}

export class TutorApplication {
  #probeService;
  #phaseService;
  #exerciseService;
  #resultValidator;
  #evaluator;
  #learnerModel;
  #decisionService;
  #stateMachine;
  #knowledgeGraph;
  #clock;
  #closeResource;
  #probeTargetConcepts;
  #maxProbeQuestions;
  #targetDifficulty;
  #session = null;

  constructor({
    probeService,
    phaseService,
    exerciseService,
    resultValidator,
    evaluator,
    learnerModel,
    decisionService,
    stateMachine,
    knowledgeGraph,
    clock = () => new Date().toISOString(),
    closeResource = null,
    probeTargetConcepts,
    maxProbeQuestions = 8,
    targetDifficulty = "medium",
  }) {
    const requirements = [
      [probeService, ["start", "submitAnswer"], "ProbeService B13"],
      [phaseService, ["plan", "teach"], "TutorPhaseService B18"],
      [exerciseService, ["generate"], "ExerciseService B15"],
      [resultValidator, ["validate"], "ResultValidator B16"],
      [evaluator, ["evaluate"], "Evaluator B17"],
      [learnerModel, ["update"], "Learner Model Service B08"],
      [decisionService, ["decide"], "Adaptive Decision Service B10"],
      [stateMachine, ["create", "transition", "applyAdaptiveDecision", "applyProbeSession"], "State Machine B14"],
      [knowledgeGraph, ["getConcept"], "Knowledge Graph B09"],
    ];
    for (const [dependency, methods, label] of requirements) {
      if (!dependency || methods.some((method) => typeof dependency[method] !== "function")) {
        throw new TypeError(`TutorApplication requer ${label}.`);
      }
    }
    if (typeof clock !== "function") throw new TypeError("clock deve ser função.");
    if (closeResource !== null && typeof closeResource !== "function") {
      throw new TypeError("closeResource deve ser null ou função.");
    }
    if (!Number.isSafeInteger(maxProbeQuestions) || maxProbeQuestions < 5 || maxProbeQuestions > 12) {
      throw new TypeError("maxProbeQuestions deve estar entre 5 e 12.");
    }
    if (!["low", "medium", "high"].includes(targetDifficulty)) {
      throw new TypeError("targetDifficulty deve ser low, medium ou high.");
    }
    if (probeTargetConcepts !== undefined && (
      !Array.isArray(probeTargetConcepts)
      || probeTargetConcepts.length === 0
      || probeTargetConcepts.some((item) => typeof item !== "string" || item.trim() === "")
    )) {
      throw new TypeError("probeTargetConcepts deve ser um array não vazio quando informado.");
    }
    this.#probeService = probeService;
    this.#phaseService = phaseService;
    this.#exerciseService = exerciseService;
    this.#resultValidator = resultValidator;
    this.#evaluator = evaluator;
    this.#learnerModel = learnerModel;
    this.#decisionService = decisionService;
    this.#stateMachine = stateMachine;
    this.#knowledgeGraph = knowledgeGraph;
    this.#clock = clock;
    this.#closeResource = closeResource;
    this.#probeTargetConcepts = probeTargetConcepts;
    this.#maxProbeQuestions = maxProbeQuestions;
    this.#targetDifficulty = targetDifficulty;
  }

  get session() {
    return this.#session;
  }

  async start({ learningGoal }) {
    if (this.#session !== null) fail("session_exists", "Já existe uma sessão em memória.");
    const goal = string(learningGoal, "learningGoal");
    const at = timestamp(this.#clock);
    const sessionId = stableId("learning-session", goal, at);
    const flowState = this.#stateMachine.create({ sessionId, createdAt: at });
    this.#session = createTutorApplicationSession({
      id: sessionId,
      learning_goal: goal,
      status: "active",
      probe_session: null,
      flow_state: flowState,
      learner_state: null,
      current_exercise: null,
      last_decision: null,
      retry_count: 0,
      attempts: [],
      validations: [],
      evaluations: [],
      mastery_changes: [],
      policy_version: TERMINAL_APPLICATION_POLICY_VERSION,
      created_at: at,
      updated_at: at,
    });
    const events = [createApplicationEvent("welcome", {
      session_id: sessionId,
      learning_goal: goal,
      message: "Sessão iniciada. O diagnóstico PROBE vem antes do ensino.",
    })];

    let probe;
    try {
      probe = await this.#probeService.start({
        learningGoal: goal,
        targetConcepts: this.#probeTargetConcepts,
        maxQuestions: this.#maxProbeQuestions,
        sessionId,
      });
    } catch (error) {
      return this.#failSession(error, "probe_completed", events, at);
    }
    this.#session = createTutorApplicationSession({
      ...this.#session,
      probe_session: probe,
      learner_state: probe.learner_state,
      updated_at: probe.updated_at,
    });
    if (probe.status === "error") {
      return this.#applyProbeFailure(probe, events);
    }
    events.push(probeQuestionEvent(probe));
    return createApplicationResult(this.#session, events);
  }

  async submitProbeAnswer(answer) {
    this.#requireActivePhase("PROBE");
    if (this.#session.probe_session?.status !== "active") {
      fail("probe_inactive", "Não existe pergunta PROBE ativa.");
    }
    const learnerAnswer = string(answer, "answer");
    let probe;
    try {
      probe = await this.#probeService.submitAnswer(
        this.#session.probe_session,
        { answer: learnerAnswer },
      );
    } catch (error) {
      return this.#failSession(error, "probe_completed", [], timestamp(this.#clock));
    }
    this.#session = createTutorApplicationSession({
      ...this.#session,
      probe_session: probe,
      learner_state: probe.learner_state,
      updated_at: probe.updated_at,
    });
    if (probe.status === "error") return this.#applyProbeFailure(probe, []);
    if (probe.status === "active") {
      return createApplicationResult(this.#session, [probeQuestionEvent(probe)]);
    }

    const flowState = this.#stateMachine.applyProbeSession(
      this.#session.flow_state,
      probe,
      {
        timestamp: probe.updated_at,
        currentConcept: probe.result.next_concept_recommended ?? undefined,
      },
    );
    this.#session = createTutorApplicationSession({
      ...this.#session,
      flow_state: flowState,
      updated_at: probe.updated_at,
    });
    return createApplicationResult(this.#session, [
      probeCompletedEvent(probe),
      progressEvent(probe.learner_state, flowState.current_concept),
    ]);
  }

  async prepareLearningCycle() {
    this.#requireActiveSession();
    const events = [];
    for (let step = 0; step < 6; step += 1) {
      const phase = this.#session.flow_state.phase;
      const currentConcept = this.#session.flow_state.current_concept;
      if (phase === "PLAN") {
        const result = await this.#phaseService.plan({
          learningGoal: this.#session.learning_goal,
          currentConcept,
          learnerState: this.#session.learner_state,
          recentMessages: [],
        });
        if (result.status !== "ok") {
          events.push(createApplicationEvent("error", result.error));
          return createApplicationResult(this.#session, events);
        }
        events.push(createApplicationEvent("plan", {
          message: result.output.message_to_learner,
          focus_concepts: result.output.focus_concepts,
          rationale: result.output.sequence_rationale,
        }));
        this.#transition("plan_ready", "Plano pedagógico apresentado.");
        continue;
      }
      if (phase === "TEACH") {
        const result = await this.#phaseService.teach({
          learningGoal: this.#session.learning_goal,
          currentConcept,
          learnerState: this.#session.learner_state,
          recentMessages: [],
        });
        if (result.status !== "ok") {
          events.push(createApplicationEvent("error", result.error));
          return createApplicationResult(this.#session, events);
        }
        events.push(createApplicationEvent("teach", {
          message: result.output.message_to_learner,
          concepts: result.output.concepts,
          comprehension_check: result.output.comprehension_check,
        }));
        this.#transition("teaching_completed", "Etapa de ensino apresentada.");
        continue;
      }
      if (phase === "REVIEW") {
        events.push(createApplicationEvent("review_placeholder", {
          message: "B10 solicitou REVIEW. B18 preserva a transição e retorna à prática; o agendamento cumulativo pertence a B22.",
          current_concept: currentConcept,
        }));
        this.#transition("review_completed", "Placeholder seguro de REVIEW concluído em B18.");
        continue;
      }
      if (["APPLY", "TRANSFER_TEST"].includes(phase)) {
        events.push(createApplicationEvent("error", {
          category: "phase_placeholder",
          code: "p1_phase_not_implemented",
          message: `A fase ${phase} permanece preservada; sua atividade completa pertence aos requisitos P1.`,
          retryable: false,
        }));
        return createApplicationResult(this.#session, events);
      }
      if (phase === "PRACTICE") {
        if (
          this.#session.current_exercise !== null
          && this.#session.flow_state.current_exercise_id
            === this.#session.current_exercise.exercise.id
        ) {
          events.push(publicExerciseEvent(this.#session.current_exercise, { reused: true }));
          return createApplicationResult(this.#session, events);
        }
        let generated;
        try {
          generated = await this.#exerciseService.generate({
            currentConcept,
            learnerState: this.#session.learner_state,
            targetDifficulty: this.#targetDifficulty,
            pedagogicalContext: {
              phase: "PRACTICE",
              learning_goal: this.#session.learning_goal,
              integration_concepts: [],
              scenario_hint: "Use somente o dataset educacional disponível no PostgreSQL.",
              recent_messages: [],
            },
            adaptiveDecision: exerciseAdaptiveDecision(this.#session),
          });
        } catch (error) {
          events.push(createApplicationEvent("error", publicError(error, {
            category: "exercise_error",
            code: "exercise_generation_failed",
            message: "Não foi possível preparar um exercício agora.",
            retryable: true,
          })));
          return createApplicationResult(this.#session, events);
        }
        if (generated.status !== "ok") {
          events.push(createApplicationEvent("error", publicError(generated.error, {
            message: "Não foi possível preparar um exercício agora.",
          })));
          return createApplicationResult(this.#session, events);
        }
        const trusted = createTrustedCurrentExercise(
          generated.exercise,
          generated.validation_metadata,
        );
        const at = timestamp(this.#clock);
        const flowState = this.#stateMachine.transition(
          this.#session.flow_state,
          "exercise_ready",
          {
            reason: "Exercise Service B15 produziu exercício válido.",
            timestamp: at,
            exercise_id: trusted.exercise.id,
          },
        );
        this.#session = createTutorApplicationSession({
          ...this.#session,
          flow_state: flowState,
          current_exercise: trusted,
          updated_at: at,
        });
        events.push(publicExerciseEvent(trusted));
        return createApplicationResult(this.#session, events);
      }
      events.push(createApplicationEvent("error", {
        category: "flow_error",
        code: "unexpected_phase",
        message: `A fase ${phase} não aceita preparação de conteúdo neste momento.`,
        retryable: false,
      }));
      return createApplicationResult(this.#session, events);
    }
    events.push(createApplicationEvent("error", {
      category: "flow_error",
      code: "preparation_limit_reached",
      message: "O limite interno de transições automáticas foi atingido.",
      retryable: false,
    }));
    return createApplicationResult(this.#session, events);
  }

  async submitSql(sql) {
    this.#requireActivePhase("PRACTICE");
    const studentSql = string(sql, "sql");
    const trusted = this.#session.current_exercise;
    if (trusted === null) fail("missing_exercise", "Não existe exercício ativo.");
    const at = timestamp(this.#clock);
    const attempt = createAttempt({
      id: `attempt:${this.#session.id}:${this.#session.attempts.length + 1}`,
      session_id: this.#session.id,
      exercise_id: trusted.exercise.id,
      submission: studentSql,
      execution_evidence_id: null,
      submitted_at: at,
    });
    let flowState = this.#stateMachine.transition(
      this.#session.flow_state,
      "answer_submitted",
      {
        reason: "Aluno submeteu SQL para o exercício ativo.",
        timestamp: at,
        exercise_id: trusted.exercise.id,
      },
    );
    this.#session = createTutorApplicationSession({
      ...this.#session,
      flow_state: flowState,
      attempts: [...this.#session.attempts, attempt],
      updated_at: at,
    });

    try {
      const validation = await this.#resultValidator.validate({
        exercise: toLearnerExercise(trusted.exercise),
        trustedValidationMetadata: trusted.validation_metadata,
        studentSql,
      });
      const evaluatorResult = await this.#evaluator.evaluate({
        exercise: toLearnerExercise(trusted.exercise),
        attempt,
        validationResult: validation,
        learnerState: this.#session.learner_state,
        evaluatedConcepts: trusted.validation_metadata.concepts_evaluated,
        recentMessages: [],
      });
      const evaluatedAt = evaluatorResult.evaluation.evaluated_at;
      flowState = this.#stateMachine.transition(flowState, "evaluation_completed", {
        reason: "Evaluator B17 produziu Evaluation estruturada.",
        timestamp: evaluatedAt,
        evaluation_id: evaluatorResult.evaluation.id,
      });
      const update = this.#learnerModel.update(
        this.#session.learner_state,
        evaluatorResult.evaluation,
      );
      const decision = this.#decisionService.decide({
        learner_state: update.learner_state,
        evaluation: evaluatorResult.evaluation,
        knowledge_graph: this.#knowledgeGraph,
        current_concept: flowState.current_concept,
        retry_count: this.#session.retry_count,
      });
      flowState = this.#stateMachine.applyAdaptiveDecision(
        flowState,
        decision,
        { timestamp: evaluatedAt },
      );
      const keepExercise = decision.action === "retry";
      this.#session = createTutorApplicationSession({
        ...this.#session,
        flow_state: flowState,
        learner_state: update.learner_state,
        current_exercise: keepExercise ? trusted : null,
        last_decision: decision,
        retry_count: keepExercise ? this.#session.retry_count + 1 : 0,
        validations: [...this.#session.validations, validation],
        evaluations: [...this.#session.evaluations, evaluatorResult],
        mastery_changes: [...this.#session.mastery_changes, ...update.mastery_changes],
        updated_at: evaluatedAt,
      });
      return createApplicationResult(this.#session, [
        executionEvent(validation, evaluatorResult),
        feedbackEvent(evaluatorResult),
        progressEvent(update.learner_state, flowState.current_concept),
        decisionEvent(decision),
      ]);
    } catch (error) {
      return this.#failSession(error, "evaluation_completed", [], at);
    }
  }

  endSession(reason = "manual_exit") {
    if (this.#session === null) return null;
    if (!EXITABLE_SESSION_STATUSES.has(this.#session.status)) {
      return createApplicationResult(this.#session, []);
    }
    const at = timestamp(this.#clock);
    this.#session = createTutorApplicationSession({
      ...this.#session,
      status: "ended",
      updated_at: at,
    });
    return createApplicationResult(this.#session, [
      createApplicationEvent("session_ended", {
        reason,
        message: "Sessão encerrada. O estado desta versão existia somente em memória.",
      }),
    ]);
  }

  async close() {
    if (this.#closeResource !== null) await this.#closeResource();
  }

  #transition(event, reason) {
    const at = timestamp(this.#clock);
    const flowState = this.#stateMachine.transition(this.#session.flow_state, event, {
      reason,
      timestamp: at,
    });
    this.#session = createTutorApplicationSession({
      ...this.#session,
      flow_state: flowState,
      current_exercise: flowState.current_exercise_id === null
        ? null
        : this.#session.current_exercise,
      updated_at: at,
    });
  }

  #requireActiveSession() {
    if (this.#session === null) fail("missing_session", "A sessão ainda não foi iniciada.");
    if (this.#session.status !== "active") fail("inactive_session", "A sessão não está ativa.");
  }

  #requireActivePhase(phase) {
    this.#requireActiveSession();
    if (this.#session.flow_state.phase !== phase) {
      fail("invalid_phase", `A operação exige a fase ${phase}.`);
    }
  }

  #applyProbeFailure(probe, events) {
    const flowState = this.#stateMachine.applyProbeSession(
      this.#session.flow_state,
      probe,
      { timestamp: probe.updated_at },
    );
    this.#session = createTutorApplicationSession({
      ...this.#session,
      status: "error",
      flow_state: flowState,
      updated_at: probe.updated_at,
    });
    events.push(createApplicationEvent("error", {
      category: probe.error.category,
      code: probe.error.code,
      message: probe.error.message,
      retryable: flowState.error.retryable,
    }));
    return createApplicationResult(this.#session, events);
  }

  #failSession(error, failedEvent, events, at) {
    const safe = publicError(error, {
      message: "O fluxo encontrou uma falha interna sanitizada.",
      retryable: false,
    });
    let flowState = this.#session.flow_state;
    if (flowState.status === "active") {
      flowState = this.#stateMachine.transition(flowState, "failure", {
        reason: "Falha explícita na coordenação B18.",
        timestamp: at,
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
          failed_event: failedEvent,
        },
      });
    }
    this.#session = createTutorApplicationSession({
      ...this.#session,
      status: "error",
      flow_state: flowState,
      updated_at: at,
    });
    events.push(createApplicationEvent("error", safe));
    return createApplicationResult(this.#session, events);
  }
}
