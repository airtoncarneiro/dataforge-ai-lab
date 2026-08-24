import { createHash } from "node:crypto";

const FORBIDDEN_KEYS = new Set([
  "api_key", "openai_api_key", "password", "connection_string", "database_url",
  "reference_query", "reference_solution", "validation_metadata", "trusted_validation_metadata",
  "instructions", "messages", "prompt", "conversation", "submission", "student_sql", "sql",
]);

function redactedString(value) {
  return value
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/giu, "[REDACTED_CONNECTION_STRING]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\b(?:api[_ -]?key|password)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_SECRET]");
}

export function sqlFingerprint(sql) {
  return createHash("sha256").update(String(sql)).digest("hex").slice(0, 24);
}

export function redact(value, key = "") {
  if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") return redactedString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redact(entryValue, entryKey),
    ]));
  }
  return value;
}
