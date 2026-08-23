import { createHash } from "node:crypto";

function canonicalNumber(value) {
  if (Object.is(value, -0)) {
    return "0";
  }
  return String(value);
}

function canonicalObject(value) {
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, canonicalValue(value[key])]);
  return ["object", entries];
}

export function canonicalValue(value) {
  if (value === null) {
    return ["null"];
  }
  if (value instanceof Date) {
    return ["timestamp", value.toISOString()];
  }
  if (typeof value === "number") {
    return ["number", canonicalNumber(value)];
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return ["date", value];
    }
    if (
      /^\d{4}-\d{2}-\d{2}T/u.test(value)
      && !Number.isNaN(new Date(value).getTime())
    ) {
      return ["timestamp", new Date(value).toISOString()];
    }
    return ["string", value];
  }
  if (typeof value === "boolean") {
    return ["boolean", value];
  }
  if (Array.isArray(value)) {
    return ["array", value.map(canonicalValue)];
  }
  if (value && typeof value === "object") {
    return canonicalObject(value);
  }
  return [typeof value, String(value)];
}

export function canonicalRow(row, columns) {
  return JSON.stringify(columns.map((column) => (
    Object.hasOwn(row, column)
      ? canonicalValue(row[column])
      : ["missing"]
  )));
}

function rowSignatures(rows, columns) {
  return rows.map((row) => canonicalRow(row, columns));
}

function multiset(signatures) {
  const counts = new Map();
  for (const signature of signatures) {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function sameMultiset(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [signature, count] of left) {
    if (right.get(signature) !== count) {
      return false;
    }
  }
  return true;
}

function sameSequence(left, right) {
  return left.length === right.length
    && left.every((signature, index) => signature === right[index]);
}

export function compareResultRows({ expectedRows, actualRows, columns, ordered }) {
  const expected = rowSignatures(expectedRows, columns);
  const actual = rowSignatures(actualRows, columns);
  const multisetsEqual = sameMultiset(multiset(expected), multiset(actual));
  return Object.freeze({
    same_multiset: multisetsEqual,
    same_order: multisetsEqual && sameSequence(expected, actual),
    passed: ordered
      ? multisetsEqual && sameSequence(expected, actual)
      : multisetsEqual,
  });
}

export function resultDigest(rows, columns, { ordered }) {
  const signatures = rowSignatures(rows, columns);
  const normalized = ordered ? signatures : [...signatures].sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function sameColumns(left, right) {
  return left.length === right.length
    && left.every((column, index) => column === right[index]);
}

