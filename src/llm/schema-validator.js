import Ajv from "ajv";

import { LlmConfigurationError } from "./errors.js";

function isCanonicalDateTime(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
ajv.addFormat("date-time", { type: "string", validate: isCanonicalDateTime });

function normalizeValidationErrors(errors = []) {
  return errors.map((error) => Object.freeze({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }));
}

export function compileOutputSchema(schema) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new LlmConfigurationError(
      "invalid_output_schema",
      "The expected output schema must be a valid JSON Schema object.",
    );
  }

  try {
    const validate = ajv.compile(schema);
    return (value) => {
      const valid = validate(value);
      return Object.freeze({
        valid,
        errors: Object.freeze(valid ? [] : normalizeValidationErrors(validate.errors)),
      });
    };
  } catch {
    throw new LlmConfigurationError(
      "invalid_output_schema",
      "The expected output schema must be a valid JSON Schema object.",
    );
  }
}
