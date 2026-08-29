import { DomainValidationError, createExercise } from "../domain/index.js";
import {
  ExerciseValidationError,
  createExerciseValidationMetadata,
  toLearnerExercise,
} from "../exercise/index.js";
import { SqlPolicyError } from "../sandbox/sql-policy.js";
import { compareResultRows, resultDigest, sameColumns } from "./comparison.js";
import {
  assertSupportedConstraints,
  evaluateConstraints,
  needsAst,
  needsPlan,
} from "./constraints.js";
import {
  RESULT_VALIDATOR_POLICY_VERSION,
  ResultValidatorConfigurationError,
  cloneJson,
  createResultValidation,
} from "./contracts.js";

const SUPPORTED_STRATEGIES = Object.freeze([
  "RESULT_SET",
  "ORDERED_RESULT",
  "PROPERTY_BASED",
  "PLAN_CONSTRAINT",
]);

function fail(code, message) {
  throw new ResultValidatorConfigurationError(code, message);
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_shape", `${path} deve ser um objeto JSON simples.`);
  }
  return value;
}

function exactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unknown_field", `${path}.${key} não é permitido.`);
    }
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_value", `${path} deve ser uma string não vazia.`);
  }
  return value;
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function normalizePublicExercise(input) {
  const value = record(input, "exercise");
  exactKeys(value, [
    "id",
    "concepts",
    "difficulty",
    "objective",
    "statement",
    "expected_skills",
    "validation_strategy",
    "created_at",
  ], "exercise");
  try {
    const internal = createExercise({
      ...value,
      evaluation_notes: [],
      reference_solution: null,
    }, "ResultValidator.exercise");
    return toLearnerExercise(internal);
  } catch (error) {
    if (error instanceof DomainValidationError || error instanceof ExerciseValidationError) {
      fail("invalid_exercise", "exercise não atende ao contrato público B15.");
    }
    throw error;
  }
}

function normalizeMetadata(input) {
  try {
    return createExerciseValidationMetadata(input, "trustedValidationMetadata");
  } catch (error) {
    if (error instanceof ExerciseValidationError) {
      fail("invalid_metadata", "trustedValidationMetadata não atende ao contrato B15.");
    }
    throw error;
  }
}

function expectedSummary(metadata, expectedRowCount, referenceExecuted) {
  return {
    comparison_mode: metadata.comparison_mode,
    expected_columns: [...metadata.expected_columns],
    expected_row_count: expectedRowCount,
    ordering_required: metadata.ordering_required,
    reference_executed: referenceExecuted,
  };
}

function actualSummary(execution, ordered) {
  if (!execution || execution.status !== "ok") {
    return null;
  }
  return {
    columns: [...execution.columns],
    row_count: execution.row_count,
    truncated: execution.truncated,
    result_digest: resultDigest(execution.rows, execution.columns, { ordered }),
  };
}

function mismatch(code, field, expected, actual) {
  return Object.freeze({ code, field, expected, actual });
}

function buildResult({
  status,
  execution,
  metadata,
  expectedRowCount,
  referenceExecuted,
  mismatches = [],
  constraints = [],
  planEvidence = null,
}) {
  const safeExecution = execution === null ? null : cloneJson(execution, "execution");
  return createResultValidation({
    status,
    correct: status === "correct",
    execution: safeExecution,
    expected_summary: expectedSummary(metadata, expectedRowCount, referenceExecuted),
    actual_summary: actualSummary(
      safeExecution,
      metadata.ordering_required,
    ),
    mismatches,
    constraints,
    plan_evidence: planEvidence === null ? null : cloneJson(planEvidence, "planEvidence"),
    validator_policy_version: RESULT_VALIDATOR_POLICY_VERSION,
  });
}

function referenceFailure({ metadata, code, expectedRowCount = null, referenceExecuted }) {
  return buildResult({
    status: "reference_validation_error",
    execution: null,
    metadata,
    expectedRowCount,
    referenceExecuted,
    mismatches: [mismatch(code, "trusted_validation_metadata", "valid", "invalid")],
  });
}

function studentFailure(execution, metadata, expectedRowCount, referenceExecuted) {
  const category = execution.error?.category;
  const status = category === "security_violation"
    ? "security_violation"
    : category === "timeout"
      ? "timeout"
      : "execution_error";
  return buildResult({
    status,
    execution,
    metadata,
    expectedRowCount,
    referenceExecuted,
    mismatches: [mismatch(
      "student_execution_error",
      "execution.status",
      "ok",
      category ?? "execution_error",
    )],
  });
}

function assertMetadataConsistency(exercise, metadata) {
  if (!SUPPORTED_STRATEGIES.includes(exercise.validation_strategy)) {
    fail("unsupported_strategy", `Estratégia não suportada: ${exercise.validation_strategy}.`);
  }
  if (exercise.validation_strategy !== metadata.comparison_mode) {
    fail("metadata_mismatch", "comparison_mode difere da validation_strategy pública.");
  }
  if (!sameValues(exercise.concepts, metadata.concepts_evaluated)) {
    fail("metadata_mismatch", "concepts_evaluated difere dos conceitos públicos.");
  }
  const ordered = exercise.validation_strategy === "ORDERED_RESULT";
  if (metadata.ordering_required !== ordered) {
    fail(
      "metadata_mismatch",
      "ordering_required deve ser verdadeiro somente para ORDERED_RESULT.",
    );
  }
  if (
    ["RESULT_SET", "ORDERED_RESULT"].includes(exercise.validation_strategy)
    && metadata.reference_query === null
  ) {
    fail("missing_reference_query", "A estratégia exige reference_query trusted.");
  }
  if (exercise.validation_strategy === "PROPERTY_BASED" && metadata.constraints.length === 0) {
    fail("metadata_mismatch", "PROPERTY_BASED exige constraints objetivas.");
  }
  if (
    exercise.validation_strategy === "PLAN_CONSTRAINT"
    && !metadata.constraints.some((constraint) => constraint.kind === "plan_property")
  ) {
    fail("metadata_mismatch", "PLAN_CONSTRAINT exige ao menos uma constraint de plano.");
  }
  assertSupportedConstraints(metadata.constraints, metadata.expected_columns);
}

function configurationFailure(metadata, error) {
  const code = error instanceof ResultValidatorConfigurationError
    && error.code === "unsupported_constraint"
    ? "unsupported_constraint"
    : "metadata_mismatch";
  return referenceFailure({
    metadata,
    code,
    expectedRowCount: metadata.expected_row_count,
    referenceExecuted: false,
  });
}

function resultStatus(mismatches, constraintEvidence) {
  const codes = new Set(mismatches.map((item) => item.code));
  if (codes.has("wrong_columns")) return "wrong_columns";
  if (codes.has("wrong_row_count")) return "wrong_row_count";
  if (codes.has("ordering_mismatch")) return "ordering_mismatch";
  if (codes.has("incorrect_result") || codes.has("actual_result_truncated")) {
    return "incorrect_result";
  }
  if (constraintEvidence.some((item) => !item.passed)) return "constraint_violation";
  return "correct";
}

export class ResultValidator {
  #sandbox;

  constructor({ sandbox }) {
    if (
      !sandbox
      || typeof sandbox.execute !== "function"
      || typeof sandbox.explain !== "function"
      || !sandbox.policy
      || typeof sandbox.policy.validate !== "function"
    ) {
      throw new TypeError("ResultValidator requer o SQL Sandbox B04–B06.");
    }
    this.#sandbox = sandbox;
  }

  // Preview is an execution-only path for the terminal. It deliberately does
  // not consume exercise metadata and never performs objective/pedagogical
  // validation; SQL still runs through the same Sandbox policy and limits.
  async preview(studentSql) {
    return this.#sandbox.execute(requiredString(studentSql, "studentSql"));
  }

  async validate(input) {
    const value = record(input, "ResultValidatorInput");
    exactKeys(value, [
      "exercise",
      "trustedValidationMetadata",
      "studentSql",
    ], "ResultValidatorInput");
    const exercise = normalizePublicExercise(value.exercise);
    const metadata = normalizeMetadata(value.trustedValidationMetadata);
    const studentSql = requiredString(value.studentSql, "studentSql");

    try {
      assertMetadataConsistency(exercise, metadata);
    } catch (error) {
      if (error instanceof ResultValidatorConfigurationError) {
        return configurationFailure(metadata, error);
      }
      throw error;
    }

    const referenceRequired = ["RESULT_SET", "ORDERED_RESULT"].includes(
      metadata.comparison_mode,
    );
    const referenceUsefulForPlan = metadata.comparison_mode === "PLAN_CONSTRAINT"
      && metadata.reference_query !== null;
    const executeReference = referenceRequired || referenceUsefulForPlan;
    let referenceExecution = null;
    let expectedRowCount = metadata.expected_row_count;

    if (executeReference) {
      referenceExecution = await this.#sandbox.execute(metadata.reference_query);
      if (referenceExecution.status !== "ok") {
        const invalid = ["syntax_error", "security_violation"].includes(
          referenceExecution.error?.category,
        );
        return referenceFailure({
          metadata,
          code: invalid ? "reference_query_invalid" : "reference_execution_error",
          expectedRowCount,
          referenceExecuted: true,
        });
      }
      if (referenceExecution.truncated) {
        return referenceFailure({
          metadata,
          code: "reference_result_truncated",
          expectedRowCount,
          referenceExecuted: true,
        });
      }
      if (!sameColumns(referenceExecution.columns, metadata.expected_columns)) {
        return referenceFailure({
          metadata,
          code: "reference_columns_mismatch",
          expectedRowCount,
          referenceExecuted: true,
        });
      }
      if (
        expectedRowCount !== null
        && referenceExecution.row_count !== expectedRowCount
      ) {
        return referenceFailure({
          metadata,
          code: "reference_row_count_mismatch",
          expectedRowCount,
          referenceExecuted: true,
        });
      }
      expectedRowCount ??= referenceExecution.row_count;
    }

    const execution = await this.#sandbox.execute(studentSql);
    if (execution.status !== "ok") {
      return studentFailure(execution, metadata, expectedRowCount, executeReference);
    }

    let approvedAst = null;
    if (needsAst(metadata.constraints)) {
      try {
        approvedAst = this.#sandbox.policy.validate(studentSql).ast;
      } catch (error) {
        if (error instanceof SqlPolicyError) {
          return studentFailure({
            status: "error",
            columns: [],
            rows: [],
            row_count: 0,
            truncated: false,
            duration_ms: execution.duration_ms,
            error: {
              category: error.category,
              sqlstate: null,
              message: "A consulta não pôde ser inspecionada.",
            },
          }, metadata, expectedRowCount, executeReference);
        }
        throw error;
      }
    }

    let planEvidence = null;
    if (needsPlan(metadata.comparison_mode, metadata.constraints)) {
      planEvidence = await this.#sandbox.explain(studentSql, { analyze: false });
      if (planEvidence.status !== "ok") {
        const category = planEvidence.error?.category;
        const status = category === "security_violation"
          ? "security_violation"
          : category === "timeout"
            ? "timeout"
            : "execution_error";
        return buildResult({
          status,
          execution,
          metadata,
          expectedRowCount,
          referenceExecuted: executeReference,
          planEvidence,
          mismatches: [mismatch(
            "plan_validation_error",
            "plan.status",
            "ok",
            category ?? "execution_error",
          )],
        });
      }
    }

    const mismatches = [];
    const columnsMatch = sameColumns(execution.columns, metadata.expected_columns);
    if (!columnsMatch) {
      mismatches.push(mismatch(
        "wrong_columns",
        "execution.columns",
        metadata.expected_columns,
        execution.columns,
      ));
    }
    if (expectedRowCount !== null && execution.row_count !== expectedRowCount) {
      mismatches.push(mismatch(
        "wrong_row_count",
        "execution.row_count",
        expectedRowCount,
        execution.row_count,
      ));
    }
    if (execution.truncated) {
      mismatches.push(mismatch(
        "actual_result_truncated",
        "execution.truncated",
        false,
        true,
      ));
    }

    if (
      referenceExecution !== null
      && columnsMatch
      && !execution.truncated
      && execution.row_count === referenceExecution.row_count
    ) {
      const comparison = compareResultRows({
        expectedRows: referenceExecution.rows,
        actualRows: execution.rows,
        columns: metadata.expected_columns,
        ordered: metadata.ordering_required,
      });
      if (!comparison.same_multiset) {
        mismatches.push(mismatch(
          "incorrect_result",
          "execution.rows",
          "reference_multiset",
          "different_multiset",
        ));
      } else if (metadata.ordering_required && !comparison.same_order) {
        mismatches.push(mismatch(
          "ordering_mismatch",
          "execution.rows.order",
          "reference_order",
          "different_order",
        ));
      }
    }

    let constraintEvidence;
    try {
      constraintEvidence = evaluateConstraints(metadata.constraints, {
        execution,
        ast: approvedAst,
        plan: planEvidence?.plan ?? null,
      });
    } catch (error) {
      if (error instanceof ResultValidatorConfigurationError) {
        return referenceFailure({
          metadata,
          code: "unsupported_constraint",
          expectedRowCount,
          referenceExecuted: executeReference,
        });
      }
      throw error;
    }
    if (constraintEvidence.some((item) => !item.passed)) {
      mismatches.push(mismatch(
        "constraint_violation",
        "constraints",
        "all_passed",
        "one_or_more_failed",
      ));
    }

    const status = resultStatus(mismatches, constraintEvidence);
    return buildResult({
      status,
      execution,
      metadata,
      expectedRowCount,
      referenceExecuted: executeReference,
      mismatches,
      constraints: constraintEvidence,
      planEvidence,
    });
  }
}
