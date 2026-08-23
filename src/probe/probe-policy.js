import { OPERATIONAL_MASTERY } from "../knowledge-graph/index.js";

export const PROBE_POLICY_VERSION = "probe-policy-v1";
export const PROBE_MIN_QUESTIONS = 5;
export const PROBE_MAX_QUESTIONS = 12;
export const PROBE_DEFAULT_MAX_QUESTIONS = 8;

const SQL_DIAGNOSTIC_ANCHORS = Object.freeze([
  "where",
  "null",
  "aggregate_functions",
  "join",
  "subqueries",
]);

const GOAL_ALIASES = Object.freeze({
  select: ["select", "projecao", "projection"],
  where: ["where", "filtro", "filtering"],
  order_by: ["order by", "ordenacao"],
  null: ["null", "nulo"],
  case: ["case", "condicional"],
  aggregate_functions: ["aggregate", "agregacao", "funcoes agregadas"],
  group_by: ["group by", "agrupamento"],
  having: ["having"],
  join: ["join", "juncao"],
  subqueries: ["subquery", "subqueries", "subconsulta"],
  cte: ["cte", "common table expression"],
  window_functions: ["window function", "funcoes de janela"],
  date_time: ["date", "time", "data", "tempo"],
  indexes: ["index", "indice"],
  explain: ["explain", "plano de execucao"],
  query_optimization: ["optimization", "otimizacao"],
});

function normalizeText(value) {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
}

function stateByConcept(session) {
  return new Map(session.learner_state.concepts.map((state) => [state.concept, state]));
}

function evidenceCount(state) {
  return state.evidence_summary.positive_attempts + state.evidence_summary.negative_attempts;
}

function topologicalIds(graph) {
  return graph.getConcepts().map((node) => node.id);
}

function depth(graph, concept) {
  return graph.getTransitivePrerequisites(concept).length;
}

function orderedByDiagnosticValue(concepts, graph) {
  const order = new Map(topologicalIds(graph).map((concept, index) => [concept, index]));
  return [...concepts].sort((left, right) => (
    depth(graph, right) - depth(graph, left)
    || order.get(left) - order.get(right)
  ));
}

export function resolveProbeTargets({ learningGoal, requestedConcepts, knowledgeGraph }) {
  const graphIds = topologicalIds(knowledgeGraph);
  const known = new Set(graphIds);
  let primary;

  if (requestedConcepts !== undefined) {
    if (!Array.isArray(requestedConcepts) || requestedConcepts.length === 0) {
      throw new TypeError("targetConcepts deve conter ao menos um conceito.");
    }
    primary = [...new Set(requestedConcepts)];
  } else {
    const normalizedGoal = normalizeText(learningGoal);
    primary = graphIds.filter((concept) => (
      (GOAL_ALIASES[concept] ?? [concept]).some((alias) => normalizedGoal.includes(alias))
    ));
    if (primary.length === 0 && /\bsql\b/u.test(normalizedGoal)) {
      primary = SQL_DIAGNOSTIC_ANCHORS.filter((concept) => known.has(concept));
    }
  }

  const unknown = primary.filter((concept) => !known.has(concept));
  if (unknown.length > 0) {
    throw new TypeError(`Conceito(s) inexistente(s) no Knowledge Graph: ${unknown.join(", ")}.`);
  }
  if (primary.length === 0) {
    throw new TypeError("O objetivo não identifica um conceito SQL; informe targetConcepts.");
  }

  const targetSet = new Set(primary);
  for (const concept of primary) {
    for (const prerequisite of knowledgeGraph.getTransitivePrerequisites(concept)) {
      targetSet.add(prerequisite.id);
    }
  }

  return Object.freeze({
    primary_concepts: Object.freeze(graphIds.filter((concept) => primary.includes(concept))),
    target_concepts: Object.freeze(graphIds.filter((concept) => targetSet.has(concept))),
  });
}

export function selectInitialProbeConcept(targets, knowledgeGraph) {
  return orderedByDiagnosticValue(targets.primary_concepts, knowledgeGraph)[0];
}

function lastAnsweredEntry(session) {
  return [...session.history].reverse().find((entry) => entry.evaluation !== null) ?? null;
}

function hasNegativeSignal(evaluation) {
  return !evaluation.assessment.correct
    || evaluation.assessment.conceptual_errors.length > 0
    || evaluation.assessment.misconceptions.some((item) => item.status !== "resolved")
    || evaluation.mastery_evidence.some((item) => item.direction === "down");
}

function prerequisiteCandidates(session, knowledgeGraph, lastEntry) {
  if (!lastEntry || !hasNegativeSignal(lastEntry.evaluation)) {
    return [];
  }
  const current = lastEntry.question.concept;
  const allowed = new Set(session.target_concepts);
  const requested = lastEntry.evaluation.assessment.prerequisites_to_revisit;
  const candidates = requested.length > 0
    ? requested
    : knowledgeGraph.getDirectPrerequisites(current).map((node) => node.id);
  const legitimate = new Set(
    knowledgeGraph.getTransitivePrerequisites(current).map((node) => node.id),
  );
  return candidates.filter((concept) => allowed.has(concept) && legitimate.has(concept));
}

function leastKnown(concepts, session, knowledgeGraph) {
  const states = stateByConcept(session);
  const evaluated = new Set(session.evaluated_concepts);
  const order = new Map(topologicalIds(knowledgeGraph).map((concept, index) => [concept, index]));
  return [...concepts].sort((left, right) => {
    const leftState = states.get(left);
    const rightState = states.get(right);
    return Number(evaluated.has(left)) - Number(evaluated.has(right))
      || evidenceCount(leftState) - evidenceCount(rightState)
      || leftState.mastery - rightState.mastery
      || order.get(left) - order.get(right);
  })[0] ?? null;
}

export function selectNextProbeConcept(session, knowledgeGraph) {
  const lastEntry = lastAnsweredEntry(session);
  const prerequisites = prerequisiteCandidates(session, knowledgeGraph, lastEntry);
  if (prerequisites.length > 0) {
    return Object.freeze({
      concept: leastKnown(prerequisites, session, knowledgeGraph),
      intent: "prerequisite_check",
    });
  }

  const evaluated = new Set(session.evaluated_concepts);
  const unassessedPrimary = orderedByDiagnosticValue(
    session.primary_concepts.filter((concept) => !evaluated.has(concept)),
    knowledgeGraph,
  );
  if (unassessedPrimary.length > 0) {
    return Object.freeze({ concept: unassessedPrimary[0], intent: "coverage" });
  }
  const unassessedTargets = session.target_concepts.filter((concept) => !evaluated.has(concept));
  if (unassessedTargets.length > 0) {
    return Object.freeze({ concept: unassessedTargets[0], intent: "coverage" });
  }

  return Object.freeze({
    concept: leastKnown(session.primary_concepts, session, knowledgeGraph),
    intent: "depth_check",
  });
}

export function nextProbeDifficulty(session, intent) {
  const lastEntry = lastAnsweredEntry(session);
  if (!lastEntry) {
    return 3;
  }
  if (intent === "prerequisite_check") {
    return Math.max(1, session.current_difficulty - 1);
  }
  const positive = lastEntry.evaluation.mastery_evidence.some(
    (item) => item.direction === "up" && ["medium", "strong"].includes(item.strength),
  );
  if (lastEntry.evaluation.assessment.correct && positive) {
    return Math.min(5, session.current_difficulty + 1);
  }
  if (hasNegativeSignal(lastEntry.evaluation)) {
    return Math.max(1, session.current_difficulty - 1);
  }
  return session.current_difficulty;
}

export function probeQuestionType(questionNumber, intent) {
  if (questionNumber === 1) {
    return "comparative";
  }
  if (intent === "prerequisite_check") {
    return "explanatory";
  }
  const rotation = ["conceptual", "explanatory", "comparative", "small_problem"];
  return rotation[(questionNumber - 2) % rotation.length];
}

export function probeQuestionTargets(concept, knowledgeGraph) {
  const direct = knowledgeGraph.getDirectPrerequisites(concept).map((node) => node.id);
  return Object.freeze([concept, ...direct.slice(0, 1)]);
}

function strongestEvidenceFor(concept, session) {
  const strengths = { weak: 1, medium: 2, strong: 3 };
  let strongest = 0;
  for (const entry of session.history) {
    for (const evidence of entry.evaluation?.mastery_evidence ?? []) {
      if (evidence.concept === concept) {
        strongest = Math.max(strongest, strengths[evidence.strength]);
      }
    }
  }
  return strongest;
}

function gapPrerequisitesCovered(concept, session, knowledgeGraph) {
  const evaluated = new Set(session.evaluated_concepts);
  return knowledgeGraph.getDirectPrerequisites(concept).every((node) => evaluated.has(node.id));
}

export function decideProbeCompletion(session, knowledgeGraph) {
  if (session.question_count >= session.max_questions) {
    return "max_questions";
  }
  if (session.question_count < PROBE_MIN_QUESTIONS) {
    return null;
  }

  const states = stateByConcept(session);
  const evaluated = new Set(session.evaluated_concepts);
  const covered = session.primary_concepts.every((concept) => evaluated.has(concept));
  const evidenceSufficient = session.primary_concepts.every((concept) => {
    const state = states.get(concept);
    return state.confidence !== "low"
      || evidenceCount(state) >= 2
      || strongestEvidenceFor(concept, session) >= 3;
  });
  const gapsInvestigated = session.primary_concepts.every((concept) => {
    const state = states.get(concept);
    const hasActiveMisconception = state.misconceptions.some((item) => item.status !== "resolved");
    if (state.mastery >= 0.5 && !hasActiveMisconception) {
      return true;
    }
    return gapPrerequisitesCovered(concept, session, knowledgeGraph);
  });

  return covered && evidenceSufficient && gapsInvestigated
    ? "sufficient_evidence"
    : null;
}

export function buildProbeResult(session, knowledgeGraph, completionReason) {
  const states = stateByConcept(session);
  const mastered = [];
  const partial = [];
  const gaps = [];
  const activeMisconceptions = [];

  for (const concept of session.target_concepts) {
    const state = states.get(concept);
    const active = state.misconceptions.filter((item) => item.status !== "resolved");
    activeMisconceptions.push(...active.map((item) => ({
      id: item.id,
      concept: item.concept,
      description: item.description,
      status: item.status,
    })));
    if (state.mastery >= OPERATIONAL_MASTERY && state.confidence !== "low" && active.length === 0) {
      mastered.push(concept);
    } else if (state.mastery >= 0.5 && active.length === 0) {
      partial.push(concept);
    } else {
      gaps.push(concept);
    }
  }

  const available = knowledgeGraph.getAvailableConcepts(session.learner_state)
    .map((node) => node.id);
  const nextConcept = available.find((concept) => gaps.includes(concept))
    ?? available.find((concept) => session.target_concepts.includes(concept))
    ?? gaps[0]
    ?? partial[0]
    ?? null;

  return Object.freeze({
    evaluated_concepts: [...session.evaluated_concepts],
    mastered_concepts: mastered,
    partial_concepts: partial,
    gaps,
    confidence: session.target_concepts.map((concept) => ({
      concept,
      confidence: states.get(concept).confidence,
    })),
    misconceptions: activeMisconceptions,
    next_concept_recommended: nextConcept,
    completion_reason: completionReason,
  });
}
