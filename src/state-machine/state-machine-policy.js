export const LEARNING_FLOW_POLICY_VERSION = "learning-flow-policy-v1";
export const LEARNING_FLOW_EVENT_VERSION = "learning-flow-events-v1";

export const LEARNING_FLOW_PHASES = Object.freeze([
  "PROBE",
  "PLAN",
  "TEACH",
  "PRACTICE",
  "EVALUATE",
  "ADAPT",
  "REVIEW",
  "APPLY",
  "TRANSFER_TEST",
  "COMPLETED",
]);

export const LEARNING_FLOW_STATUSES = Object.freeze([
  "active",
  "completed",
  "error",
]);

export const LEARNING_FLOW_EVENTS = Object.freeze([
  "probe_completed",
  "plan_ready",
  "teaching_completed",
  "exercise_ready",
  "answer_submitted",
  "evaluation_completed",
  "retry_requested",
  "reteach_requested",
  "practice_requested",
  "advance_requested",
  "review_requested",
  "review_completed",
  "apply_ready",
  "apply_completed",
  "transfer_test_ready",
  "transfer_test_completed",
  "learning_completed",
  "failure",
  "resume_requested",
]);

export const ADAPTIVE_EVENT_BY_ACTION = Object.freeze({
  retry: "retry_requested",
  reteach: "reteach_requested",
  practice: "practice_requested",
  advance: "advance_requested",
  review: "review_requested",
});

export const ADAPTIVE_FLOW_EVENTS = Object.freeze(Object.values(ADAPTIVE_EVENT_BY_ACTION));

const rules = [
  ["PROBE", "probe_completed", "PLAN"],
  ["PLAN", "plan_ready", "TEACH"],
  ["TEACH", "teaching_completed", "PRACTICE"],
  ["PRACTICE", "exercise_ready", "PRACTICE"],
  ["PRACTICE", "answer_submitted", "EVALUATE"],
  ["EVALUATE", "evaluation_completed", "ADAPT"],
  ["EVALUATE", "learning_completed", "COMPLETED"],
  ["ADAPT", "retry_requested", "PRACTICE"],
  ["ADAPT", "reteach_requested", "TEACH"],
  ["ADAPT", "practice_requested", "PRACTICE"],
  ["ADAPT", "advance_requested", "TEACH"],
  ["ADAPT", "review_requested", "REVIEW"],
  ["ADAPT", "apply_ready", "APPLY"],
  ["ADAPT", "transfer_test_ready", "TRANSFER_TEST"],
  ["REVIEW", "review_completed", "PRACTICE"],
  ["REVIEW", "apply_ready", "APPLY"],
  ["APPLY", "apply_completed", "EVALUATE"],
  ["TRANSFER_TEST", "transfer_test_completed", "EVALUATE"],
];

export const LEARNING_FLOW_TRANSITIONS = Object.freeze(rules.map(
  ([from, event, to]) => Object.freeze({ from, event, to }),
));

export function findLearningFlowTransition(phase, status, event) {
  if (status === "completed") {
    return null;
  }
  if (status === "error") {
    return event === "resume_requested"
      ? Object.freeze({ from: phase, event, to: phase })
      : null;
  }
  if (event === "failure") {
    return Object.freeze({ from: phase, event, to: phase });
  }
  return LEARNING_FLOW_TRANSITIONS.find(
    (rule) => rule.from === phase && rule.event === event,
  ) ?? null;
}
