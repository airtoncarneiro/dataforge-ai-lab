import { parse, toSql } from "pgsql-ast-parser";

export const ERROR_CATEGORIES = Object.freeze({
  SYNTAX: "syntax_error",
  SECURITY: "security_violation",
  TIMEOUT: "timeout",
  EXECUTION: "execution_error",
});

export const DEFAULT_ALLOWED_RELATIONS = Object.freeze([
  "categories",
  "customers",
  "departments",
  "employees",
  "order_items",
  "orders",
  "products",
]);

export const DEFAULT_ALLOWED_FUNCTIONS = Object.freeze([
  "abs",
  "age",
  "array_agg",
  "avg",
  "bool_and",
  "bool_or",
  "btrim",
  "ceil",
  "ceiling",
  "char_length",
  "coalesce",
  "concat",
  "concat_ws",
  "count",
  "date_part",
  "date_trunc",
  "dense_rank",
  "first_value",
  "floor",
  "generate_series",
  "greatest",
  "lag",
  "last_value",
  "lead",
  "least",
  "left",
  "length",
  "lower",
  "ltrim",
  "make_date",
  "max",
  "min",
  "mod",
  "now",
  "nth_value",
  "ntile",
  "nullif",
  "position",
  "power",
  "rank",
  "replace",
  "right",
  "round",
  "row_number",
  "rtrim",
  "split_part",
  "sqrt",
  "string_agg",
  "substr",
  "substring",
  "sum",
  "to_char",
  "to_date",
  "trim",
  "trunc",
  "upper",
]);

const READ_STATEMENT_TYPES = new Set(["select", "union", "union all", "with", "with recursive"]);

const FORBIDDEN_NODE_TYPES = new Set([
  "alter index",
  "alter sequence",
  "alter table",
  "begin",
  "commit",
  "comment",
  "create extension",
  "create function",
  "create index",
  "create materialized view",
  "create schema",
  "create sequence",
  "create table",
  "create type",
  "create view",
  "deallocate",
  "delete",
  "do",
  "drop function",
  "drop index",
  "drop materialized view",
  "drop schema",
  "drop sequence",
  "drop table",
  "drop type",
  "drop view",
  "insert",
  "prepare",
  "refresh materialized view",
  "rollback",
  "set",
  "set names",
  "set timezone",
  "show",
  "start transaction",
  "tablespace",
  "truncate table",
  "update",
  "values",
]);

const FORBIDDEN_LEADING_KEYWORDS = new Set([
  "alter",
  "analyze",
  "begin",
  "call",
  "cluster",
  "comment",
  "commit",
  "copy",
  "create",
  "deallocate",
  "delete",
  "discard",
  "do",
  "drop",
  "execute",
  "explain",
  "grant",
  "insert",
  "listen",
  "lock",
  "notify",
  "prepare",
  "refresh",
  "reindex",
  "release",
  "reset",
  "revoke",
  "rollback",
  "savepoint",
  "set",
  "show",
  "start",
  "truncate",
  "unlisten",
  "update",
  "vacuum",
]);

export class SqlPolicyError extends Error {
  constructor(category, message) {
    super(message);
    this.name = "SqlPolicyError";
    this.category = category;
  }
}

function syntaxError() {
  return new SqlPolicyError(ERROR_CATEGORIES.SYNTAX, "A consulta possui sintaxe SQL inválida.");
}

function securityError() {
  return new SqlPolicyError(
    ERROR_CATEGORIES.SECURITY,
    "A consulta viola a política de segurança do sandbox.",
  );
}

function firstKeyword(sql) {
  let position = 0;

  while (position < sql.length) {
    while (/\s/u.test(sql[position] ?? "")) {
      position += 1;
    }

    if (sql.startsWith("--", position)) {
      const lineEnd = sql.indexOf("\n", position + 2);
      position = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }

    if (sql.startsWith("/*", position)) {
      const commentEnd = sql.indexOf("*/", position + 2);
      if (commentEnd === -1) {
        return null;
      }
      position = commentEnd + 2;
      continue;
    }

    break;
  }

  const keyword = sql.slice(position).match(/^[a-z_]+/iu);
  return keyword?.[0].toLowerCase() ?? null;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

export class SqlPolicy {
  constructor({
    allowedSchema = "education",
    allowedRelations = DEFAULT_ALLOWED_RELATIONS,
    allowedFunctions = DEFAULT_ALLOWED_FUNCTIONS,
    maxSqlLength = 20_000,
  } = {}) {
    this.allowedSchema = allowedSchema;
    this.allowedRelations = new Set(allowedRelations);
    this.allowedFunctions = new Set(allowedFunctions);
    this.maxSqlLength = maxSqlLength;
  }

  validate(sql) {
    if (typeof sql !== "string" || sql.trim() === "") {
      throw syntaxError();
    }

    if (sql.length > this.maxSqlLength) {
      throw securityError();
    }

    let statements;
    try {
      statements = parse(sql);
    } catch {
      const keyword = firstKeyword(sql);
      const unsupportedSelectInto = keyword === "select" && /\binto\b/iu.test(sql);
      if ((keyword && FORBIDDEN_LEADING_KEYWORDS.has(keyword)) || unsupportedSelectInto) {
        throw securityError();
      }
      throw syntaxError();
    }

    if (statements.length !== 1) {
      throw securityError();
    }

    this.#validateStatement(statements[0], new Set());

    return Object.freeze({
      ast: statements[0],
      sql: toSql.statement(statements[0]),
    });
  }

  #validateStatement(statement, visibleCtes) {
    if (!isObject(statement) || !READ_STATEMENT_TYPES.has(statement.type)) {
      throw securityError();
    }

    if (statement.type === "with") {
      const scopedCtes = new Set(visibleCtes);
      for (const binding of statement.bind) {
        this.#validateStatement(binding.statement, scopedCtes);
        scopedCtes.add(binding.alias.name);
      }
      this.#validateStatement(statement.in, scopedCtes);
      return;
    }

    if (statement.type === "with recursive") {
      const scopedCtes = new Set(visibleCtes);
      scopedCtes.add(statement.alias.name);
      this.#validateStatement(statement.bind, scopedCtes);
      this.#validateStatement(statement.in, scopedCtes);
      return;
    }

    if (statement.type === "union" || statement.type === "union all") {
      this.#validateStatement(statement.left, visibleCtes);
      this.#validateStatement(statement.right, visibleCtes);
      return;
    }

    if (statement.for || statement.skip || statement.into) {
      throw securityError();
    }

    for (const [key, value] of Object.entries(statement)) {
      if (key !== "type") {
        this.#walk(value, visibleCtes);
      }
    }
  }

  #walk(value, visibleCtes) {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.#walk(item, visibleCtes);
      }
      return;
    }

    if (!isObject(value)) {
      return;
    }

    if (READ_STATEMENT_TYPES.has(value.type)) {
      this.#validateStatement(value, visibleCtes);
      return;
    }

    if (FORBIDDEN_NODE_TYPES.has(value.type)) {
      throw securityError();
    }

    if (value.type === "table") {
      this.#validateRelation(value.name, visibleCtes);
    }

    if (value.type === "call") {
      this.#validateFunction(value.function);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "type" && key !== "name" && key !== "function") {
        this.#walk(child, visibleCtes);
      }
    }
  }

  #validateRelation(relation, visibleCtes) {
    const { name, schema } = relation;

    if (!schema && visibleCtes.has(name)) {
      return;
    }

    if ((schema && schema !== this.allowedSchema) || !this.allowedRelations.has(name)) {
      throw securityError();
    }
  }

  #validateFunction(func) {
    if (func.schema || !this.allowedFunctions.has(func.name)) {
      throw securityError();
    }
  }
}
