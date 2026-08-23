export class DomainValidationError extends TypeError {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "DomainValidationError";
    this.path = path;
  }
}

function fail(path, message) {
  throw new DomainValidationError(path, message);
}

export function assertRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "deve ser um objeto");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "deve ser um objeto JSON simples");
  }
  return value;
}

export function assertExactKeys(value, allowedKeys, path) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "campo desconhecido");
    }
  }
}

export function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "deve ser uma string não vazia");
  }
  return value;
}

export function nullableString(value, path) {
  return value === null ? null : requiredString(value, path);
}

export function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(path, `deve ser um de: ${allowed.join(", ")}`);
  }
  return value;
}

export function booleanValue(value, path) {
  if (typeof value !== "boolean") {
    fail(path, "deve ser booleano");
  }
  return value;
}

export function finiteNumber(value, path, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(path, `deve ser um número finito entre ${min} e ${max}`);
  }
  return value;
}

export function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "deve ser um inteiro não negativo");
  }
  return value;
}

export function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(path, "deve ser um inteiro positivo");
  }
  return value;
}

export function canonicalTimestamp(value, path) {
  requiredString(value, path);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(path, "deve ser um timestamp ISO 8601 UTC canônico");
  }
  return value;
}

export function arrayOf(value, path, mapper, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail(path, `deve ser um array com pelo menos ${min} item(ns)`);
  }
  return value.map((item, index) => mapper(item, `${path}[${index}]`));
}

export function stringArray(value, path, { min = 0, unique = true } = {}) {
  const normalized = arrayOf(value, path, requiredString, { min });
  if (unique && new Set(normalized).size !== normalized.length) {
    fail(path, "não deve conter valores duplicados");
  }
  return normalized;
}

export function scalarJsonValue(value, path) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  fail(path, "deve ser um valor JSON escalar");
}

export function jsonValue(value, path, seen = new Set()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      fail(path, "não deve conter referência circular");
    }
    seen.add(value);
    const result = value.map((item, index) => jsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  assertRecord(value, path);
  if (seen.has(value)) {
    fail(path, "não deve conter referência circular");
  }
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = jsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
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

export function valueOrDefault(record, key, defaultValue) {
  return record[key] === undefined ? defaultValue : record[key];
}
