import { AdaptiveDecisionService } from "../adaptive-decision/index.js";
import { EvaluatorService } from "../evaluator/index.js";
import { ExerciseService } from "../exercise/index.js";
import { SQL_KNOWLEDGE_GRAPH } from "../knowledge-graph/index.js";
import { LearnerModelService } from "../learner-model/index.js";
import { ConsoleJsonLogger } from "../logging/index.js";
import {
  DemoLlmProvider,
  LlmAdapter,
  createLlmAdapterFromEnv,
} from "../llm/index.js";
import { ProbeService } from "../probe/index.js";
import { createPostgresSessionStoreFromEnv } from "../persistence/index.js";
import { ResultValidator } from "../result-validator/index.js";
import { createSqlSandboxFromEnv } from "../sandbox/sql-sandbox.js";
import { LearningStateMachine } from "../state-machine/index.js";
import {
  TUTOR_POLICY_VERSION,
  createTutorPolicyContextBuilder,
} from "../tutor-policy/index.js";
import { TutorApplication } from "./tutor-application.js";
import { TutorPhaseService } from "./tutor-phase-service.js";

function integer(value, fallback, { min, max }) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`Configuração deve ser inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}

function difficulty(value) {
  const normalized = value?.trim().toLowerCase() || "medium";
  if (!["low", "medium", "high"].includes(normalized)) {
    throw new TypeError("SQL_MENTOR_TARGET_DIFFICULTY deve ser low, medium ou high.");
  }
  return normalized;
}

function createDemoAdapter(logger) {
  return new LlmAdapter({
    provider: new DemoLlmProvider(),
    policyVersion: TUTOR_POLICY_VERSION,
    timeoutMs: 1_000,
    maxRetries: 0,
    parameters: { temperature: 0 },
    logger,
  });
}

export async function createTutorApplicationFromEnv({
  env = process.env,
  demo = false,
  clock = () => new Date().toISOString(),
  logger = new ConsoleJsonLogger(),
} = {}) {
  const knowledgeGraph = SQL_KNOWLEDGE_GRAPH;
  const learnerModel = new LearnerModelService();
  const adapter = demo ? createDemoAdapter(logger) : createLlmAdapterFromEnv(env, { logger });
  const policyBuilder = await createTutorPolicyContextBuilder();
  const sandbox = createSqlSandboxFromEnv(env);
  const sessionStore = createPostgresSessionStoreFromEnv(env);
  const stateMachine = new LearningStateMachine({ clock });

  return new TutorApplication({
    probeService: new ProbeService({
      adapter,
      policyBuilder,
      knowledgeGraph,
      learnerModel,
      clock,
    }),
    phaseService: new TutorPhaseService({ adapter, policyBuilder, knowledgeGraph }),
    exerciseService: new ExerciseService({
      adapter,
      policyBuilder,
      knowledgeGraph,
      clock,
    }),
    resultValidator: new ResultValidator({ sandbox }),
    evaluator: new EvaluatorService({
      adapter,
      policyBuilder,
      knowledgeGraph,
      clock,
    }),
    learnerModel,
    decisionService: new AdaptiveDecisionService(),
    stateMachine,
    knowledgeGraph,
    clock,
    closeResource: async () => {
      await Promise.all([sandbox.close(), sessionStore.close()]);
    },
    sessionStore,
    logger,
    probeTargetConcepts: demo ? ["select"] : undefined,
    maxProbeQuestions: integer(
      env.SQL_MENTOR_PROBE_MAX_QUESTIONS,
      demo ? 5 : 8,
      { min: 5, max: 12 },
    ),
    targetDifficulty: difficulty(env.SQL_MENTOR_TARGET_DIFFICULTY),
  });
}
