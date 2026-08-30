import {
  CorruptSessionSnapshotError,
  IdempotencyConflictError,
  SessionNotFoundError,
  assertSessionSnapshot,
  cloneSnapshot,
  sameJson,
} from "./contracts.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class InMemorySessionStore {
  #snapshots = new Map();

  async createSession(session) {
    const snapshot = assertSessionSnapshot(session);
    const existing = this.#snapshots.get(snapshot.id);
    if (existing && !sameJson(existing, snapshot)) {
      throw new IdempotencyConflictError("LearningSession", snapshot.id);
    }
    this.#snapshots.set(snapshot.id, clone(snapshot));
    return cloneSnapshot(snapshot);
  }

  async getSession(sessionId) {
    const value = this.#snapshots.get(sessionId);
    if (!value) throw new SessionNotFoundError(sessionId);
    return cloneSnapshot(value);
  }

  async saveSessionSnapshot(session) {
    const snapshot = assertSessionSnapshot(session);
    if (!this.#snapshots.has(snapshot.id)) throw new SessionNotFoundError(snapshot.id);
    this.#snapshots.set(snapshot.id, clone(snapshot));
    return cloneSnapshot(snapshot);
  }

  async loadSessionSnapshot(sessionId) {
    return this.getSession(sessionId);
  }

  async loadLatestSessionSnapshot() {
    const snapshots = [...this.#snapshots.values()]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    if (snapshots.length === 0) throw new SessionNotFoundError("latest");
    return cloneSnapshot(snapshots[0]);
  }

  async saveLearnerState(sessionId, learnerState) {
    return this.#replace(sessionId, { learner_state: learnerState });
  }

  async saveProbeSession(sessionId, probeSession) {
    return this.#replace(sessionId, { probe_session: probeSession });
  }

  async saveFlowState(sessionId, flowState) {
    return this.#replace(sessionId, { flow_state: flowState });
  }

  async saveExercise(sessionId, currentExercise) {
    return this.#replace(sessionId, { current_exercise: currentExercise });
  }

  async saveAttempt(sessionId, attempt) {
    const session = await this.getSession(sessionId);
    const existing = session.attempts.find((item) => item.id === attempt.id);
    if (existing) {
      if (!sameJson(existing, attempt)) throw new IdempotencyConflictError("Attempt", attempt.id);
      return session;
    }
    return this.#replace(sessionId, { attempts: [...session.attempts, attempt] });
  }

  async saveEvaluation(sessionId, evaluatorResult) {
    const session = await this.getSession(sessionId);
    const id = evaluatorResult.evaluation.id;
    const existing = session.evaluations.find((item) => item.evaluation.id === id);
    if (existing) {
      if (!sameJson(existing, evaluatorResult)) {
        throw new IdempotencyConflictError("Evaluation", id);
      }
      return session;
    }
    return this.#replace(sessionId, { evaluations: [...session.evaluations, evaluatorResult] });
  }

  async saveMasteryChanges(sessionId, changes) {
    const session = await this.getSession(sessionId);
    const existing = new Map(session.mastery_changes.map((item) => [item.id, item]));
    for (const change of changes) {
      if (existing.has(change.id) && !sameJson(existing.get(change.id), change)) {
        throw new IdempotencyConflictError("MasteryChange", change.id);
      }
      existing.set(change.id, change);
    }
    return this.#replace(sessionId, { mastery_changes: [...existing.values()] });
  }

  async saveDecision(sessionId, decision) {
    return this.#replace(sessionId, { last_decision: decision });
  }

  async #replace(sessionId, patch) {
    const previous = await this.getSession(sessionId);
    const snapshot = { ...previous, ...patch };
    try {
      return await this.saveSessionSnapshot(snapshot);
    } catch (error) {
      if (error instanceof CorruptSessionSnapshotError) throw error;
      throw error;
    }
  }
}
