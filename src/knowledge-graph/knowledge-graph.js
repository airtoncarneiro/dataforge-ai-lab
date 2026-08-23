import { createLearnerState } from "../domain/index.js";

export const OPERATIONAL_MASTERY = 0.8;

export class InvalidKnowledgeGraphError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "InvalidKnowledgeGraphError";
    this.code = code;
  }
}

export class UnknownKnowledgeConceptError extends Error {
  constructor(conceptId) {
    super(`Conceito inexistente no Knowledge Graph: ${conceptId}.`);
    this.name = "UnknownKnowledgeConceptError";
    this.concept_id = conceptId;
  }
}

function fail(code, message) {
  throw new InvalidKnowledgeGraphError(code, message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um objeto.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  return value;
}

function assertExactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unknown_field", `${path}.${key} não é um campo permitido.`);
    }
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_value", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

function conceptId(value, path) {
  const normalized = requiredString(value, path);
  if (!/^[a-z][a-z0-9_]*$/u.test(normalized)) {
    fail("invalid_concept_id", `${path} deve usar snake_case estável.`);
  }
  return normalized;
}

function normalizeNode(input, index) {
  const path = `KnowledgeGraph.nodes[${index}]`;
  const value = assertRecord(input, path);
  assertExactKeys(value, ["id", "label", "description", "prerequisites"], path);
  if (!Array.isArray(value.prerequisites)) {
    fail("invalid_shape", `${path}.prerequisites deve ser um array.`);
  }
  const prerequisites = value.prerequisites.map((item, prerequisiteIndex) => conceptId(
    item,
    `${path}.prerequisites[${prerequisiteIndex}]`,
  ));
  if (new Set(prerequisites).size !== prerequisites.length) {
    fail("duplicate_prerequisite", `${path}.prerequisites contém valores duplicados.`);
  }

  return Object.freeze({
    id: conceptId(value.id, `${path}.id`),
    label: requiredString(value.label, `${path}.label`),
    description: requiredString(value.description, `${path}.description`),
    prerequisites: Object.freeze(prerequisites),
  });
}

function stableTopologicalOrder(nodes, nodesById, directDependents) {
  const inputPosition = new Map(nodes.map((node, index) => [node.id, index]));
  const inDegree = new Map(nodes.map((node) => [node.id, node.prerequisites.length]));
  const ready = nodes.filter((node) => node.prerequisites.length === 0).map((node) => node.id);
  const order = [];

  while (ready.length > 0) {
    ready.sort((left, right) => inputPosition.get(left) - inputPosition.get(right));
    const current = ready.shift();
    order.push(current);
    for (const dependent of directDependents.get(current)) {
      const remaining = inDegree.get(dependent) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
  }

  if (order.length !== nodesById.size) {
    const involved = nodes
      .filter((node) => inDegree.get(node.id) > 0)
      .map((node) => node.id);
    fail("cycle", `Knowledge Graph contém ciclo envolvendo: ${involved.join(", ")}.`);
  }
  return Object.freeze(order);
}

function operationalStatus(conceptState) {
  if (!conceptState) {
    return { mastered: false, reason: "missing_state", mastery: null, confidence: null };
  }
  if (conceptState.mastery < OPERATIONAL_MASTERY) {
    return {
      mastered: false,
      reason: "mastery_below_threshold",
      mastery: conceptState.mastery,
      confidence: conceptState.confidence,
    };
  }
  if (conceptState.confidence === "low") {
    return {
      mastered: false,
      reason: "confidence_low",
      mastery: conceptState.mastery,
      confidence: conceptState.confidence,
    };
  }
  return {
    mastered: true,
    reason: null,
    mastery: conceptState.mastery,
    confidence: conceptState.confidence,
  };
}

export class KnowledgeGraph {
  #nodesById;

  #directDependents;

  #topologicalOrder;

  constructor(definition) {
    const value = assertRecord(definition, "KnowledgeGraph");
    assertExactKeys(value, ["version", "nodes"], "KnowledgeGraph");
    if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
      fail("invalid_shape", "KnowledgeGraph.nodes deve ser um array não vazio.");
    }

    this.version = requiredString(value.version, "KnowledgeGraph.version");
    const nodes = value.nodes.map(normalizeNode);
    this.#nodesById = new Map();
    for (const node of nodes) {
      if (this.#nodesById.has(node.id)) {
        fail("duplicate_concept", `Conceito duplicado no Knowledge Graph: ${node.id}.`);
      }
      this.#nodesById.set(node.id, node);
    }

    this.#directDependents = new Map(nodes.map((node) => [node.id, []]));
    for (const node of nodes) {
      for (const prerequisite of node.prerequisites) {
        if (!this.#nodesById.has(prerequisite)) {
          fail(
            "unknown_prerequisite",
            `O conceito ${node.id} referencia prerequisite inexistente: ${prerequisite}.`,
          );
        }
        this.#directDependents.get(prerequisite).push(node.id);
      }
    }
    for (const [id, dependents] of this.#directDependents) {
      this.#directDependents.set(id, Object.freeze(dependents));
    }
    this.#topologicalOrder = stableTopologicalOrder(
      nodes,
      this.#nodesById,
      this.#directDependents,
    );
    Object.freeze(this);
  }

  #requireConcept(conceptIdValue) {
    const node = this.#nodesById.get(conceptIdValue);
    if (!node) {
      throw new UnknownKnowledgeConceptError(conceptIdValue);
    }
    return node;
  }

  #conceptStateMap(learnerStateInput) {
    const learnerState = createLearnerState(learnerStateInput);
    return new Map(learnerState.concepts.map((state) => [state.concept, state]));
  }

  #transitiveIds(initialIds, nextIds) {
    const visited = new Set();
    const visit = (current) => {
      for (const next of nextIds(current)) {
        if (!visited.has(next)) {
          visited.add(next);
          visit(next);
        }
      }
    };
    for (const initial of initialIds) {
      if (!visited.has(initial)) {
        visited.add(initial);
        visit(initial);
      }
    }
    return this.#topologicalOrder.filter((id) => visited.has(id));
  }

  getConcept(conceptIdValue) {
    return this.#requireConcept(conceptIdValue);
  }

  getConcepts() {
    return Object.freeze(this.#topologicalOrder.map((id) => this.#nodesById.get(id)));
  }

  getDirectPrerequisites(conceptIdValue) {
    const node = this.#requireConcept(conceptIdValue);
    return Object.freeze(node.prerequisites.map((id) => this.#nodesById.get(id)));
  }

  getTransitivePrerequisites(conceptIdValue) {
    const node = this.#requireConcept(conceptIdValue);
    const ids = this.#transitiveIds(
      node.prerequisites,
      (id) => this.#nodesById.get(id).prerequisites,
    );
    return Object.freeze(ids.map((id) => this.#nodesById.get(id)));
  }

  getDirectDependents(conceptIdValue) {
    this.#requireConcept(conceptIdValue);
    const direct = new Set(this.#directDependents.get(conceptIdValue));
    return Object.freeze(
      this.#topologicalOrder.filter((id) => direct.has(id)).map((id) => this.#nodesById.get(id)),
    );
  }

  getTransitiveDependents(conceptIdValue) {
    this.#requireConcept(conceptIdValue);
    const ids = this.#transitiveIds(
      this.#directDependents.get(conceptIdValue),
      (id) => this.#directDependents.get(id),
    );
    return Object.freeze(ids.map((id) => this.#nodesById.get(id)));
  }

  getRootConcepts() {
    return Object.freeze(
      this.#topologicalOrder
        .map((id) => this.#nodesById.get(id))
        .filter((node) => node.prerequisites.length === 0),
    );
  }

  isOperationallyMastered(conceptIdValue, learnerStateInput) {
    this.#requireConcept(conceptIdValue);
    const states = this.#conceptStateMap(learnerStateInput);
    return operationalStatus(states.get(conceptIdValue)).mastered;
  }

  getPrerequisiteGaps(conceptIdValue, learnerStateInput, { transitive = true } = {}) {
    this.#requireConcept(conceptIdValue);
    if (typeof transitive !== "boolean") {
      fail("invalid_option", "transitive deve ser booleano.");
    }
    const states = this.#conceptStateMap(learnerStateInput);
    const prerequisites = transitive
      ? this.getTransitivePrerequisites(conceptIdValue)
      : this.getDirectPrerequisites(conceptIdValue);
    const gaps = [];

    for (const prerequisite of prerequisites) {
      const status = operationalStatus(states.get(prerequisite.id));
      if (!status.mastered) {
        gaps.push(Object.freeze({
          concept: prerequisite.id,
          reason: status.reason,
          mastery: status.mastery,
          confidence: status.confidence,
        }));
      }
    }
    return Object.freeze(gaps);
  }

  getAvailableConcepts(learnerStateInput) {
    const states = this.#conceptStateMap(learnerStateInput);
    const available = this.getConcepts().filter((node) => (
      !operationalStatus(states.get(node.id)).mastered
      && this.getPrerequisiteGaps(node.id, learnerStateInput).length === 0
    ));
    return Object.freeze(available);
  }

  getBlockedConcepts(learnerStateInput) {
    const states = this.#conceptStateMap(learnerStateInput);
    const blocked = this.getConcepts().filter((node) => (
      !operationalStatus(states.get(node.id)).mastered
      && this.getPrerequisiteGaps(node.id, learnerStateInput).length > 0
    ));
    return Object.freeze(blocked);
  }

  toJSON() {
    return Object.freeze({
      version: this.version,
      nodes: this.getConcepts(),
    });
  }
}
