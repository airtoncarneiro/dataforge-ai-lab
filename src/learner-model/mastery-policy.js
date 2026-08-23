export const MASTERY_POLICY_VERSION = "mastery-policy-v1";

export const MASTERY_CLASSIFICATIONS = Object.freeze({
  INSUFFICIENT: "insufficient",
  PARTIAL: "partial",
  OPERATIONAL: "operational",
});

export const EVIDENCE_DELTAS = Object.freeze({
  weak: 0.02,
  medium: 0.05,
  strong: 0.10,
});

const CONCEPTUAL_ERROR_PENALTY = 0.02;
const MAX_POSITIVE_DELTA = 0.12;
const MAX_NEGATIVE_DELTA = -0.15;
const ACTIVE_MISCONCEPTION_POSITIVE_LIMIT = 0.02;

const MISCONCEPTION_PENALTIES = Object.freeze({
  new: Object.freeze({ suspected: 0.02, confirmed: 0.04 }),
  persistent: Object.freeze({ suspected: 0.03, confirmed: 0.06 }),
  resolved: Object.freeze({ resolved: 0 }),
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value) {
  return Number(value.toFixed(3));
}

export function classifyMastery(mastery) {
  if (mastery >= 0.8) {
    return MASTERY_CLASSIFICATIONS.OPERATIONAL;
  }
  if (mastery >= 0.5) {
    return MASTERY_CLASSIFICATIONS.PARTIAL;
  }
  return MASTERY_CLASSIFICATIONS.INSUFFICIENT;
}

export function calculateMasteryUpdate({
  currentMastery,
  masteryEvidence,
  hasConceptualError,
  misconceptionEvents,
  hasActiveMisconception,
}) {
  const evidenceDelta = masteryEvidence.reduce((total, evidence) => {
    const weight = EVIDENCE_DELTAS[evidence.strength];
    return total + (evidence.direction === "up" ? weight : -weight);
  }, 0);
  const conceptualPenalty = hasConceptualError ? -CONCEPTUAL_ERROR_PENALTY : 0;
  const misconceptionPenalty = -misconceptionEvents.reduce((total, event) => {
    if (event.kind === "resolved") {
      return total;
    }
    return total + MISCONCEPTION_PENALTIES[event.kind][event.status];
  }, 0);

  let proposedDelta = evidenceDelta + conceptualPenalty + misconceptionPenalty;
  if (proposedDelta > 0 && hasActiveMisconception) {
    proposedDelta = Math.min(proposedDelta, ACTIVE_MISCONCEPTION_POSITIVE_LIMIT);
  }
  const boundedDelta = clamp(proposedDelta, MAX_NEGATIVE_DELTA, MAX_POSITIVE_DELTA);
  const newMastery = roundScore(clamp(currentMastery + boundedDelta, 0, 1));
  const appliedDelta = roundScore(newMastery - currentMastery);

  return Object.freeze({
    evidence_delta: roundScore(evidenceDelta),
    conceptual_penalty: roundScore(conceptualPenalty),
    misconception_penalty: roundScore(misconceptionPenalty),
    proposed_delta: roundScore(proposedDelta),
    applied_delta: appliedDelta,
    mastery: newMastery,
    classification: classifyMastery(newMastery),
    signal: proposedDelta > 0 ? "positive" : proposedDelta < 0 ? "negative" : "neutral",
  });
}

export function updateEvidenceSummary(summary, signal) {
  if (signal === "positive") {
    return Object.freeze({
      positive_attempts: summary.positive_attempts + 1,
      negative_attempts: summary.negative_attempts,
      consecutive_positive: summary.consecutive_positive + 1,
      consecutive_negative: 0,
    });
  }
  if (signal === "negative") {
    return Object.freeze({
      positive_attempts: summary.positive_attempts,
      negative_attempts: summary.negative_attempts + 1,
      consecutive_positive: 0,
      consecutive_negative: summary.consecutive_negative + 1,
    });
  }
  return summary;
}

function lowerConfidence(confidence) {
  if (confidence === "high") {
    return "medium";
  }
  if (confidence === "medium") {
    return "low";
  }
  return "low";
}

export function calculateConfidence({
  currentConfidence,
  evidenceSummary,
  mastery,
  hasActiveMisconception,
  hasConfirmedMisconceptionEvent,
  hasStrongNegativeEvidence,
}) {
  const shouldDecrease = hasStrongNegativeEvidence
    || hasConfirmedMisconceptionEvent
    || evidenceSummary.consecutive_negative >= 2;
  if (shouldDecrease) {
    return lowerConfidence(currentConfidence);
  }
  if (currentConfidence === "high" && hasActiveMisconception) {
    return "medium";
  }
  if (
    currentConfidence === "medium"
    && evidenceSummary.positive_attempts >= 4
    && evidenceSummary.consecutive_positive >= 3
    && mastery >= 0.8
    && !hasActiveMisconception
  ) {
    return "high";
  }
  if (currentConfidence === "low" && evidenceSummary.consecutive_positive >= 2) {
    return "medium";
  }
  return currentConfidence;
}
