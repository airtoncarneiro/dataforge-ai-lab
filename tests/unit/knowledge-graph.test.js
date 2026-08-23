import assert from "node:assert/strict";
import test from "node:test";

import { createLearnerState } from "../../src/domain/index.js";
import {
  InvalidKnowledgeGraphError,
  KnowledgeGraph,
  OPERATIONAL_MASTERY,
  SQL_KNOWLEDGE_GRAPH,
  UnknownKnowledgeConceptError,
  createSqlKnowledgeGraph,
} from "../../src/knowledge-graph/index.js";

const TIMESTAMP = "2026-08-23T12:00:00.000Z";

function node(id, prerequisites = []) {
  return {
    id,
    label: id.toUpperCase(),
    description: `Conceito ${id}.`,
    prerequisites,
  };
}

function testGraph() {
  return new KnowledgeGraph({
    version: "test-graph-v1",
    nodes: [
      node("root_a"),
      node("root_b"),
      node("mid", ["root_a"]),
      node("multi", ["mid", "root_b"]),
      node("leaf", ["multi"]),
    ],
  });
}

function conceptState(concept, mastery, confidence = "medium") {
  return {
    id: `concept-state-${concept}`,
    concept,
    mastery,
    confidence,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function learnerState(concepts) {
  return createLearnerState({
    id: "learner-state-graph-test",
    session_id: "session-graph-test",
    learning_goal: "SQL",
    concepts,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  });
}

function ids(nodes) {
  return nodes.map((item) => item.id);
}

test("aceita grafo válido e produz representação JSON imutável", () => {
  const graph = testGraph();
  const representation = graph.toJSON();

  assert.equal(graph.version, "test-graph-v1");
  assert.equal(OPERATIONAL_MASTERY, 0.8);
  assert.deepEqual(ids(graph.getConcepts()), ["root_a", "root_b", "mid", "multi", "leaf"]);
  assert.equal(JSON.parse(JSON.stringify(representation)).nodes.length, 5);
  assert.ok(Object.isFrozen(graph));
  assert.ok(Object.isFrozen(representation));
  assert.ok(Object.isFrozen(representation.nodes[0]));
});

test("rejeita ciclo no grafo", () => {
  assert.throws(
    () => new KnowledgeGraph({
      version: "cyclic-v1",
      nodes: [node("first", ["second"]), node("second", ["first"])],
    }),
    (error) => {
      assert.ok(error instanceof InvalidKnowledgeGraphError);
      assert.equal(error.code, "cycle");
      return true;
    },
  );
});

test("rejeita referência a prerequisite inexistente", () => {
  assert.throws(
    () => new KnowledgeGraph({
      version: "invalid-reference-v1",
      nodes: [node("first", ["missing"])],
    }),
    (error) => {
      assert.ok(error instanceof InvalidKnowledgeGraphError);
      assert.equal(error.code, "unknown_prerequisite");
      assert.match(error.message, /missing/u);
      return true;
    },
  );
});

test("rejeita consulta a conceito inexistente", () => {
  assert.throws(
    () => testGraph().getDirectPrerequisites("missing"),
    UnknownKnowledgeConceptError,
  );
});

test("retorna prerequisites diretos e suporta múltiplos prerequisites", () => {
  const graph = testGraph();

  assert.deepEqual(ids(graph.getDirectPrerequisites("multi")), ["mid", "root_b"]);
  assert.deepEqual(ids(graph.getDirectPrerequisites("mid")), ["root_a"]);
});

test("retorna prerequisites transitivos em ordem topológica estável", () => {
  assert.deepEqual(
    ids(testGraph().getTransitivePrerequisites("leaf")),
    ["root_a", "root_b", "mid", "multi"],
  );
});

test("retorna dependentes diretos", () => {
  assert.deepEqual(ids(testGraph().getDirectDependents("root_a")), ["mid"]);
});

test("retorna dependentes transitivos", () => {
  assert.deepEqual(
    ids(testGraph().getTransitiveDependents("root_a")),
    ["mid", "multi", "leaf"],
  );
});

test("retorna todos os conceitos raiz", () => {
  assert.deepEqual(ids(testGraph().getRootConcepts()), ["root_a", "root_b"]);
});

test("conceito fica disponível quando todos os prerequisites estão dominados", () => {
  const graph = testGraph();
  const state = learnerState([
    conceptState("root_a", 0.8, "medium"),
    conceptState("root_b", 0.9, "high"),
  ]);

  assert.deepEqual(ids(graph.getAvailableConcepts(state)), ["mid"]);
  assert.deepEqual(graph.getPrerequisiteGaps("mid", state), []);
});

test("conceito fica bloqueado quando um prerequisite não está dominado", () => {
  const graph = testGraph();
  const state = learnerState([
    conceptState("root_a", 0.79, "high"),
    conceptState("root_b", 0.9, "high"),
  ]);

  assert.ok(ids(graph.getBlockedConcepts(state)).includes("mid"));
  assert.ok(!ids(graph.getAvailableConcepts(state)).includes("mid"));
});

test("identifica exatamente lacunas transitivas e seus motivos", () => {
  const graph = testGraph();
  const state = learnerState([
    conceptState("root_a", 0.79, "medium"),
    conceptState("root_b", 0.9, "low"),
    conceptState("multi", 0.8, "high"),
  ]);

  assert.deepEqual(graph.getPrerequisiteGaps("leaf", state), [
    {
      concept: "root_a",
      reason: "mastery_below_threshold",
      mastery: 0.79,
      confidence: "medium",
    },
    {
      concept: "root_b",
      reason: "confidence_low",
      mastery: 0.9,
      confidence: "low",
    },
    {
      concept: "mid",
      reason: "missing_state",
      mastery: null,
      confidence: null,
    },
  ]);
});

test("trata mastery 0.79 como não dominado e 0.80 como operacional", () => {
  const graph = testGraph();
  const below = learnerState([conceptState("root_a", 0.79, "medium")]);
  const atThreshold = learnerState([conceptState("root_a", 0.8, "medium")]);

  assert.equal(graph.isOperationallyMastered("root_a", below), false);
  assert.equal(graph.isOperationallyMastered("root_a", atThreshold), true);
});

test("mastery operacional com confidence low ainda é lacuna", () => {
  const graph = testGraph();
  const state = learnerState([conceptState("root_a", 0.9, "low")]);

  assert.equal(graph.isOperationallyMastered("root_a", state), false);
  assert.equal(graph.getPrerequisiteGaps("mid", state)[0].reason, "confidence_low");
});

test("consultas não alteram LearnerState", () => {
  const graph = testGraph();
  const state = learnerState([
    conceptState("root_a", 0.8, "medium"),
    conceptState("root_b", 0.8, "medium"),
  ]);
  const before = JSON.stringify(state);

  graph.getAvailableConcepts(state);
  graph.getBlockedConcepts(state);
  graph.getPrerequisiteGaps("leaf", state);

  assert.equal(JSON.stringify(state), before);
  assert.ok(Object.isFrozen(state));
});

test("consultas são determinísticas", () => {
  const graph = testGraph();
  const state = learnerState([conceptState("root_a", 0.8, "medium")]);

  assert.deepEqual(graph.getTransitiveDependents("root_a"), graph.getTransitiveDependents("root_a"));
  assert.deepEqual(graph.getAvailableConcepts(state), graph.getAvailableConcepts(state));
  assert.deepEqual(graph.getBlockedConcepts(state), graph.getBlockedConcepts(state));
});

test("Knowledge Graph SQL inicial contém o escopo obrigatório sem ciclos", () => {
  const graph = createSqlKnowledgeGraph();
  const requiredConcepts = [
    "select",
    "where",
    "order_by",
    "null",
    "case",
    "aggregate_functions",
    "group_by",
    "having",
    "join",
    "subqueries",
    "cte",
    "window_functions",
    "date_time",
    "indexes",
    "explain",
    "query_optimization",
  ];

  assert.deepEqual(ids(graph.getConcepts()), requiredConcepts);
  assert.deepEqual(ids(graph.getRootConcepts()), ["select"]);
  assert.deepEqual(ids(graph.getDirectPrerequisites("having")), ["group_by", "where"]);
  assert.deepEqual(
    ids(graph.getDirectPrerequisites("window_functions")),
    ["select", "aggregate_functions", "order_by"],
  );
  assert.deepEqual(
    ids(graph.getDirectPrerequisites("indexes")),
    ["where", "order_by", "join"],
  );
  assert.deepEqual(
    ids(graph.getDirectPrerequisites("query_optimization")),
    ["indexes", "explain"],
  );
  assert.equal(SQL_KNOWLEDGE_GRAPH.version, "sql-knowledge-graph-v1");
});
