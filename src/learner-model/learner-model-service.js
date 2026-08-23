import {
  DomainValidationError,
  createConceptState,
  createEvaluation,
  createLearnerState,
  createMasteryChange,
} from "../domain/index.js";
import {
  MASTERY_POLICY_VERSION,
  calculateConfidence,
  calculateMasteryUpdate,
  updateEvidenceSummary,
} from "./mastery-policy.js";

export class UnknownConceptError extends Error {
  constructor(concepts) {
    const sortedConcepts = [...concepts].sort();
    super(`A avaliação referencia conceito(s) inexistente(s): ${sortedConcepts.join(", ")}.`);
    this.name = "UnknownConceptError";
    this.concepts = Object.freeze(sortedConcepts);
  }
}

function appendUnique(current, additions) {
  return [...new Set([...current, ...additions])];
}

function createConceptGroup() {
  return {
    masteryEvidence: [],
    conceptualErrors: [],
    misconceptions: [],
  };
}

function groupEvaluationByConcept(evaluation) {
  const groups = new Map();
  const groupFor = (concept) => {
    if (!groups.has(concept)) {
      groups.set(concept, createConceptGroup());
    }
    return groups.get(concept);
  };

  for (const evidence of evaluation.mastery_evidence) {
    groupFor(evidence.concept).masteryEvidence.push(evidence);
  }
  for (const error of evaluation.assessment.conceptual_errors) {
    groupFor(error.concept).conceptualErrors.push(error);
  }
  for (const misconception of evaluation.assessment.misconceptions) {
    groupFor(misconception.concept).misconceptions.push(misconception);
  }

  return groups;
}

function mergeMisconceptions(current, incoming) {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const merged = [];
  const events = [];

  for (const existing of current) {
    const update = incomingById.get(existing.id);
    if (!update) {
      merged.push(existing);
      continue;
    }

    const isResolved = update.status === "resolved";
    events.push({
      id: update.id,
      kind: isResolved ? "resolved" : "persistent",
      status: update.status,
    });
    merged.push({
      ...update,
      evidence_ids: appendUnique(existing.evidence_ids, update.evidence_ids),
    });
    incomingById.delete(existing.id);
  }

  for (const item of incoming) {
    if (!incomingById.has(item.id)) {
      continue;
    }
    events.push({
      id: item.id,
      kind: item.status === "resolved" ? "resolved" : "new",
      status: item.status,
    });
    merged.push(item);
    incomingById.delete(item.id);
  }

  return {
    misconceptions: merged,
    events,
  };
}

function evaluationEvidenceIdsFor(group, assessment) {
  const hasPositiveSignal = group.masteryEvidence.some((item) => item.direction === "up")
    || group.misconceptions.some((item) => item.status === "resolved");
  const hasNegativeSignal = group.masteryEvidence.some((item) => item.direction === "down")
    || group.conceptualErrors.length > 0
    || group.misconceptions.some((item) => item.status !== "resolved");
  const ids = [];

  if (hasPositiveSignal) {
    ids.push(...assessment.positive_evidence.map((item) => item.id));
  }
  if (hasNegativeSignal) {
    ids.push(...assessment.negative_evidence.map((item) => item.id));
  }
  ids.push(...group.misconceptions.flatMap((item) => item.evidence_ids));
  return appendUnique([], ids);
}

function buildReason({ policyResult, previousConfidence, newConfidence, misconceptionEvents }) {
  const misconceptionSummary = misconceptionEvents.length === 0
    ? "none"
    : misconceptionEvents
      .map((event) => `${event.kind}:${event.status}:${event.id}`)
      .join(",");

  return [
    `policy=${MASTERY_POLICY_VERSION}`,
    `evidence_delta=${policyResult.evidence_delta.toFixed(3)}`,
    `conceptual_penalty=${policyResult.conceptual_penalty.toFixed(3)}`,
    `misconception_penalty=${policyResult.misconception_penalty.toFixed(3)}`,
    `applied_delta=${policyResult.applied_delta.toFixed(3)}`,
    `confidence=${previousConfidence}->${newConfidence}`,
    `classification=${policyResult.classification}`,
    `misconceptions=${misconceptionSummary}`,
  ].join("; ");
}

function updateConcept(conceptState, group, evaluation) {
  if (evaluation.evaluated_at < conceptState.updated_at) {
    throw new DomainValidationError(
      "Evaluation.evaluated_at",
      `não pode ser anterior a ConceptState(${conceptState.concept}).updated_at`,
    );
  }

  const misconceptionMerge = mergeMisconceptions(
    conceptState.misconceptions,
    group.misconceptions,
  );
  const activeMisconceptions = misconceptionMerge.misconceptions.filter(
    (item) => item.status !== "resolved",
  );
  const policyResult = calculateMasteryUpdate({
    currentMastery: conceptState.mastery,
    masteryEvidence: group.masteryEvidence,
    hasConceptualError: group.conceptualErrors.length > 0,
    misconceptionEvents: misconceptionMerge.events,
    hasActiveMisconception: activeMisconceptions.length > 0,
  });
  const evidenceSummary = updateEvidenceSummary(
    conceptState.evidence_summary,
    policyResult.signal,
  );
  const newConfidence = calculateConfidence({
    currentConfidence: conceptState.confidence,
    evidenceSummary,
    mastery: policyResult.mastery,
    hasActiveMisconception: activeMisconceptions.length > 0,
    hasConfirmedMisconceptionEvent: misconceptionMerge.events.some(
      (event) => event.kind !== "resolved" && event.status === "confirmed",
    ),
    hasStrongNegativeEvidence: group.masteryEvidence.some(
      (item) => item.direction === "down" && item.strength === "strong",
    ),
  });
  const masteryEvidenceIds = group.masteryEvidence.map((item) => item.id);
  const evaluationEvidenceIds = evaluationEvidenceIdsFor(group, evaluation.assessment);
  const allEvidenceIds = appendUnique(
    conceptState.evidence_ids,
    [...masteryEvidenceIds, ...evaluationEvidenceIds],
  );

  const updatedConcept = createConceptState({
    id: conceptState.id,
    concept: conceptState.concept,
    mastery: policyResult.mastery,
    confidence: newConfidence,
    misconceptions: misconceptionMerge.misconceptions,
    evidence_ids: allEvidenceIds,
    evidence_summary: evidenceSummary,
    created_at: conceptState.created_at,
    updated_at: evaluation.evaluated_at,
  });
  const masteryChange = createMasteryChange({
    id: `mastery-change:${evaluation.id}:${conceptState.id}`,
    concept_state_id: conceptState.id,
    evaluation_id: evaluation.id,
    attempt_id: evaluation.attempt_id,
    previous_mastery: conceptState.mastery,
    new_mastery: policyResult.mastery,
    previous_confidence: conceptState.confidence,
    new_confidence: newConfidence,
    mastery_evidence_ids: masteryEvidenceIds,
    evaluation_evidence_ids: evaluationEvidenceIds,
    reason: buildReason({
      policyResult,
      previousConfidence: conceptState.confidence,
      newConfidence,
      misconceptionEvents: misconceptionMerge.events,
    }),
    policy_version: MASTERY_POLICY_VERSION,
    changed_at: evaluation.evaluated_at,
  });

  return { updatedConcept, masteryChange };
}

export function updateLearnerState(learnerStateInput, evaluationInput) {
  const learnerState = createLearnerState(learnerStateInput);
  const evaluation = createEvaluation(evaluationInput);
  if (evaluation.evaluated_at < learnerState.updated_at) {
    throw new DomainValidationError(
      "Evaluation.evaluated_at",
      "não pode ser anterior a LearnerState.updated_at",
    );
  }

  const groups = groupEvaluationByConcept(evaluation);
  const existingConceptNames = new Set(learnerState.concepts.map((item) => item.concept));
  const unknownConcepts = [...groups.keys()].filter((concept) => !existingConceptNames.has(concept));
  if (unknownConcepts.length > 0) {
    throw new UnknownConceptError(unknownConcepts);
  }
  if (groups.size === 0) {
    return Object.freeze({
      learner_state: learnerState,
      mastery_changes: Object.freeze([]),
    });
  }

  const masteryChanges = [];
  const concepts = learnerState.concepts.map((conceptState) => {
    const group = groups.get(conceptState.concept);
    if (!group) {
      return conceptState;
    }
    const { updatedConcept, masteryChange } = updateConcept(
      conceptState,
      group,
      evaluation,
    );
    masteryChanges.push(masteryChange);
    return updatedConcept;
  });
  const updatedLearnerState = createLearnerState({
    id: learnerState.id,
    session_id: learnerState.session_id,
    learning_goal: learnerState.learning_goal,
    concepts,
    created_at: learnerState.created_at,
    updated_at: evaluation.evaluated_at,
  });

  return Object.freeze({
    learner_state: updatedLearnerState,
    mastery_changes: Object.freeze(masteryChanges),
  });
}

export class LearnerModelService {
  update(learnerState, evaluation) {
    return updateLearnerState(learnerState, evaluation);
  }
}
