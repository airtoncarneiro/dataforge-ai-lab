import { deepFreeze } from "./utils.js";

export const TUTOR_POLICY_VERSION = "tutor-policy-v0.1";
export const TUTOR_POLICY_SOURCE_PATH = "docs/TUTOR_POLICY.md";

export const TUTOR_LIFECYCLE = deepFreeze([
  "PROBE",
  "PLAN",
  "TEACH",
  "PRACTICE",
  "EVALUATE",
  "ADAPT",
  "REVIEW",
  "APPLY",
  "TRANSFER_TEST",
]);

export const TASK_BY_PHASE = deepFreeze({
  PROBE: "probe",
  PLAN: "plan",
  TEACH: "teach",
  PRACTICE: "practice",
  EVALUATE: "evaluate",
  ADAPT: "adapt",
  REVIEW: "review",
  APPLY: "apply",
  TRANSFER_TEST: "transfer_test",
  COMPLETE: "complete",
});

export const SHARED_POLICY_SECTIONS = deepFreeze([
  "Papel",
  "2. LEARNER MODEL",
  "4. FONTES",
  "14. FEEDBACK",
  "15. CARGA COGNITIVA",
  "17. REGRAS OPERACIONAIS",
]);

export const PHASE_POLICY_SECTIONS = deepFreeze({
  PROBE: ["1. PROBE", "3. KNOWLEDGE DEPENDENCY GRAPH"],
  PLAN: ["3. KNOWLEDGE DEPENDENCY GRAPH"],
  TEACH: ["5. TEACH"],
  PRACTICE: ["6. PRACTICE", "7. EXERCISE DESIGN", "10. AUTOCORREÇÃO"],
  EVALUATE: ["8. EVALUATE", "9. ADAPT", "10. AUTOCORREÇÃO"],
  ADAPT: ["9. ADAPT", "10. AUTOCORREÇÃO"],
  REVIEW: ["6. PRACTICE", "11. REVIEW"],
  APPLY: ["12. APPLY"],
  TRANSFER_TEST: ["13. TRANSFER TEST"],
  COMPLETE: ["18. CONCLUSÃO"],
});

export const CONTEXT_FIELDS_BY_PHASE = deepFreeze({
  PROBE: ["learning_goal", "learner_state", "knowledge_graph"],
  PLAN: ["learning_goal", "learner_state", "knowledge_graph"],
  TEACH: ["learning_goal", "learner_state", "knowledge_graph"],
  PRACTICE: ["learning_goal", "learner_state", "knowledge_graph", "current_exercise"],
  EVALUATE: [
    "learning_goal",
    "learner_state",
    "knowledge_graph",
    "current_exercise",
    "attempt",
    "execution_evidence",
  ],
  ADAPT: [
    "learning_goal",
    "learner_state",
    "knowledge_graph",
    "current_exercise",
    "attempt",
    "execution_evidence",
  ],
  REVIEW: ["learning_goal", "learner_state", "knowledge_graph"],
  APPLY: ["learning_goal", "learner_state", "knowledge_graph"],
  TRANSFER_TEST: ["learning_goal", "learner_state", "knowledge_graph"],
  COMPLETE: ["learning_goal", "learner_state", "knowledge_graph"],
});

export const ALLOWED_TOOLS_BY_PHASE = deepFreeze({
  PROBE: ["get_relevant_learning_state"],
  PLAN: ["get_relevant_learning_state"],
  TEACH: ["get_allowed_schema", "get_relevant_learning_state"],
  PRACTICE: ["get_allowed_schema", "get_relevant_learning_state"],
  EVALUATE: [
    "execute_sql",
    "explain_sql",
    "get_allowed_schema",
    "get_relevant_learning_state",
  ],
  ADAPT: ["get_relevant_learning_state"],
  REVIEW: ["get_relevant_learning_state"],
  APPLY: ["get_allowed_schema", "get_relevant_learning_state"],
  TRANSFER_TEST: ["get_allowed_schema", "get_relevant_learning_state"],
  COMPLETE: ["get_relevant_learning_state"],
});

export const AUTHORITY_BOUNDARIES = deepFreeze([
  "A mastery value suggested by the LLM is evidence only, never the final score.",
  "B08 Learner Model Service is the only component that calculates mastery and confidence updates.",
  "A next_action suggested by the LLM is advisory only, never the final progression decision.",
  "B10 Adaptive Decision Service is the authority that decides retry, reteach, practice, advance or review after evaluation.",
  "Only the SQL Sandbox may execute learner SQL and produce execution or EXPLAIN evidence.",
  "Never invent SQL execution, result rows, PostgreSQL errors or execution plans.",
]);

export const REQUIRED_POLICY_MARKERS = deepFreeze([
  "PROBE -> PLAN -> TEACH -> PRACTICE -> EVALUATE -> ADAPT -> REVIEW -> APPLY -> TRANSFER TEST",
  "Active Recall / Retrieval Practice",
  "não comece ensinando",
  "A aplicação calcula/persiste o valor final segundo política própria.",
  "ERRO -> PERGUNTA SOCRÁTICA -> AUTOCORREÇÃO -> PISTA -> NOVA TENTATIVA -> EXPLICAÇÃO",
  "syntax/execution error",
  "documentação oficial do PostgreSQL",
  "COMPREENSÃO + RETENÇÃO + APLICAÇÃO + TRANSFERÊNCIA",
  "CARGA COGNITIVA",
]);
