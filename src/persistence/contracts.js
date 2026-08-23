import { createTutorApplicationSession } from "../orchestrator/contracts.js";

export const PERSISTENCE_POLICY_VERSION = "persistence-policy-v1";

export class PersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export class SessionNotFoundError extends PersistenceError {
  constructor(sessionId) {
    super("session_not_found", `Sessão persistida não encontrada: ${sessionId}.`);
  }
}

export class IdempotencyConflictError extends PersistenceError {
  constructor(entity, id) {
    super("idempotency_conflict", `${entity} ${id} já existe com conteúdo divergente.`);
  }
}

export class CorruptSessionSnapshotError extends PersistenceError {
  constructor(sessionId) {
    super("corrupt_session_snapshot", `Snapshot persistido da sessão ${sessionId} é inválido ou incompleto.`);
  }
}

export function assertSessionSnapshot(input) {
  try {
    return createTutorApplicationSession(input, "PersistedTutorApplicationSession");
  } catch {
    throw new CorruptSessionSnapshotError(input?.id ?? "unknown");
  }
}

export function cloneSnapshot(input) {
  const snapshot = assertSessionSnapshot(input);
  return JSON.parse(JSON.stringify(snapshot));
}

export function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertStore(store) {
  const methods = [
    "createSession",
    "getSession",
    "saveSessionSnapshot",
    "loadSessionSnapshot",
  ];
  if (!store || methods.some((method) => typeof store[method] !== "function")) {
    throw new TypeError("SessionStore deve implementar create/get/save/load da sessão.");
  }
  return store;
}
