export class TutorPolicyError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "TutorPolicyError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new TutorPolicyError(code, message);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function cloneJson(value, path = "value") {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      fail("invalid_json", `${path} deve ser serializável como JSON.`);
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof TutorPolicyError) {
      throw error;
    }
    fail("invalid_json", `${path} deve ser serializável como JSON.`);
  }
}

export function assertRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_context", `${path} deve ser um objeto.`);
  }
  return value;
}

export function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_context", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

export function stringArray(value, path) {
  if (!Array.isArray(value)) {
    fail("invalid_context", `${path} deve ser um array.`);
  }
  const normalized = value.map((item, index) => requiredString(item, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("invalid_context", `${path} não deve conter valores duplicados.`);
  }
  return normalized;
}
