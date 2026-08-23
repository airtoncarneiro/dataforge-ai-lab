import { canonicalValue } from "./comparison.js";
import { ResultValidatorConfigurationError } from "./contracts.js";

const AGGREGATE_FUNCTIONS = new Set([
  "array_agg",
  "avg",
  "bool_and",
  "bool_or",
  "count",
  "max",
  "min",
  "string_agg",
  "sum",
]);

const QUERY_TARGETS = Object.freeze({
  "query.has_join": "has_join",
  "query.has_group_by": "has_group_by",
  "query.has_window_function": "has_window_function",
  "query.has_order_by": "has_order_by",
  "query.has_cte": "has_cte",
  "query.has_subquery": "has_subquery",
  "query.has_aggregate": "has_aggregate",
  "query.has_where": "has_where",
  "query.has_having": "has_having",
  "query.has_distinct": "has_distinct",
});

const PLAN_TARGETS = new Set([
  "plan.node_type",
  "plan.root.node_type",
  "plan.node_types",
  "plan.index_names",
  "plan.relation_names",
  "plan.uses_index",
  "plan.max_total_cost",
  "plan.max_plan_rows",
]);

function configurationError(code, message) {
  throw new ResultValidatorConfigurationError(code, message);
}

function walkAst(ast) {
  const facts = {
    has_join: false,
    has_group_by: false,
    has_window_function: false,
    has_order_by: false,
    has_cte: ast?.type === "with" || ast?.type === "with recursive",
    has_subquery: false,
    has_aggregate: false,
    has_where: false,
    has_having: false,
    has_distinct: false,
  };
  let selectCount = 0;
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value.type === "select") {
      selectCount += 1;
      facts.has_group_by ||= Array.isArray(value.groupBy) && value.groupBy.length > 0;
      facts.has_order_by ||= Array.isArray(value.orderBy) && value.orderBy.length > 0;
      facts.has_where ||= value.where !== undefined;
      facts.has_having ||= value.having !== undefined;
      facts.has_distinct ||= value.distinct !== undefined;
    }
    facts.has_join ||= value.join !== undefined;
    facts.has_window_function ||= value.over !== undefined;
    if (
      value.type === "call"
      && typeof value.function?.name === "string"
      && AGGREGATE_FUNCTIONS.has(value.function.name.toLowerCase())
    ) {
      facts.has_aggregate = true;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  };
  visit(ast);
  facts.has_subquery = selectCount > (facts.has_cte ? 2 : 1);
  return Object.freeze(facts);
}

function planFacts(plan) {
  const nodeTypes = [];
  const indexNames = [];
  const relationNames = [];
  const totalCosts = [];
  const planRows = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (typeof node.node_type === "string") nodeTypes.push(node.node_type);
    if (typeof node.index_name === "string") indexNames.push(node.index_name);
    if (typeof node.relation_name === "string") relationNames.push(node.relation_name);
    if (typeof node.total_cost === "number") totalCosts.push(node.total_cost);
    if (typeof node.plan_rows === "number") planRows.push(node.plan_rows);
    (node.plans ?? []).forEach(visit);
  };
  visit(plan);
  return Object.freeze({
    root_node_type: plan?.node_type ?? null,
    node_types: Object.freeze(nodeTypes),
    index_names: Object.freeze(indexNames),
    relation_names: Object.freeze(relationNames),
    uses_index: indexNames.length > 0,
    max_total_cost: totalCosts.length > 0 ? Math.max(...totalCosts) : null,
    max_plan_rows: planRows.length > 0 ? Math.max(...planRows) : null,
  });
}

function resultColumnTarget(target, execution) {
  const match = target.match(/^result\.column:([^:]+)\.(null_count|distinct_count|min|max|values)$/u);
  if (!match) {
    return { supported: false, value: null };
  }
  const [, column, metric] = match;
  if (!execution.columns.includes(column)) {
    return { supported: true, value: "missing_column" };
  }
  const values = execution.rows.map((row) => row[column]);
  if (metric === "null_count") {
    return { supported: true, value: values.filter((value) => value === null).length };
  }
  if (metric === "distinct_count") {
    return {
      supported: true,
      value: new Set(values.map((value) => JSON.stringify(canonicalValue(value)))).size,
    };
  }
  if (metric === "values") {
    return { supported: true, value: values };
  }
  const comparable = values.filter((value) => value !== null);
  if (comparable.length === 0) {
    return { supported: true, value: null };
  }
  return {
    supported: true,
    value: metric === "min"
      ? comparable.reduce((left, right) => (left <= right ? left : right))
      : comparable.reduce((left, right) => (left >= right ? left : right)),
  };
}

function resolveTarget(constraint, { execution, ast, plan }) {
  if (constraint.kind === "query_structure") {
    const fact = QUERY_TARGETS[constraint.target];
    if (!fact) {
      configurationError("unsupported_constraint", `Constraint AST não suportada: ${constraint.target}.`);
    }
    return walkAst(ast)[fact];
  }
  if (constraint.kind === "result_property") {
    if (constraint.target === "result.row_count") return execution.row_count;
    if (constraint.target === "result.columns") return execution.columns;
    const columnTarget = resultColumnTarget(constraint.target, execution);
    if (columnTarget.supported) return columnTarget.value;
    configurationError(
      "unsupported_constraint",
      `Constraint de resultado não suportada: ${constraint.target}.`,
    );
  }
  if (constraint.kind === "plan_property") {
    if (!PLAN_TARGETS.has(constraint.target)) {
      configurationError("unsupported_constraint", `Constraint de plano não suportada: ${constraint.target}.`);
    }
    const facts = planFacts(plan);
    const targets = {
      "plan.node_type": facts.root_node_type,
      "plan.root.node_type": facts.root_node_type,
      "plan.node_types": facts.node_types,
      "plan.index_names": facts.index_names,
      "plan.relation_names": facts.relation_names,
      "plan.uses_index": facts.uses_index,
      "plan.max_total_cost": facts.max_total_cost,
      "plan.max_plan_rows": facts.max_plan_rows,
    };
    return targets[constraint.target];
  }
  configurationError("unsupported_constraint", `Kind não suportado: ${constraint.kind}.`);
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function contains(actual, expected) {
  if (Array.isArray(actual)) {
    return actual.some((value) => jsonEqual(value, expected));
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  return false;
}

function applyOperator(actual, operator, expected) {
  switch (operator) {
    case "equals": return jsonEqual(actual, expected);
    case "not_equals": return !jsonEqual(actual, expected);
    case "contains": return contains(actual, expected);
    case "not_contains": return !contains(actual, expected);
    case "at_least": return typeof actual === "number" && actual >= expected;
    case "at_most": return typeof actual === "number" && actual <= expected;
    case "greater_than": return typeof actual === "number" && actual > expected;
    case "less_than": return typeof actual === "number" && actual < expected;
    default:
      configurationError("unsupported_constraint", `Operador não suportado: ${operator}.`);
  }
}

export function assertSupportedConstraints(constraints, expectedColumns) {
  for (const constraint of constraints) {
    if (constraint.kind === "query_structure" && !QUERY_TARGETS[constraint.target]) {
      configurationError("unsupported_constraint", `Constraint AST não suportada: ${constraint.target}.`);
    }
    if (constraint.kind === "plan_property" && !PLAN_TARGETS.has(constraint.target)) {
      configurationError("unsupported_constraint", `Constraint de plano não suportada: ${constraint.target}.`);
    }
    if (constraint.kind === "result_property") {
      if (constraint.target === "result.row_count" || constraint.target === "result.columns") {
        continue;
      }
      const match = constraint.target.match(
        /^result\.column:([^:]+)\.(null_count|distinct_count|min|max|values)$/u,
      );
      if (!match || !expectedColumns.includes(match[1])) {
        configurationError(
          "unsupported_constraint",
          `Constraint de resultado não suportada: ${constraint.target}.`,
        );
      }
    }
  }
}

export function evaluateConstraints(constraints, context) {
  return Object.freeze(constraints.map((constraint) => {
    const actual = resolveTarget(constraint, context);
    return Object.freeze({
      kind: constraint.kind,
      target: constraint.target,
      operator: constraint.operator,
      expected: constraint.value,
      actual,
      passed: applyOperator(actual, constraint.operator, constraint.value),
    });
  }));
}

export function needsAst(constraints) {
  return constraints.some((constraint) => constraint.kind === "query_structure");
}

export function needsPlan(strategy, constraints) {
  return strategy === "PLAN_CONSTRAINT"
    || constraints.some((constraint) => constraint.kind === "plan_property");
}
