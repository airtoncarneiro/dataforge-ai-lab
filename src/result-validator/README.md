# Result Validator — B16

Componente determinístico que valida objetivamente uma SQL do aluno contra o
contrato trusted de um exercício B15. Não produz avaliação pedagógica, não chama
LLM, não altera mastery e não decide progressão.

## Fronteiras

```text
B04/B05  SQL real -> execution evidence
B06      SQL real -> EXPLAIN seguro, sem ANALYZE
B16      evidências + metadata trusted -> validação objetiva
B17      validação objetiva -> interpretação pedagógica futura
```

Tanto a SQL do aluno quanto a `reference_query` usam `SqlSandbox.execute()`. A
referência é validada/executada uma única vez quando necessária e nunca aparece
no resultado. Constraints de plano usam `SqlSandbox.explain(sql, {
analyze: false })`.

## API

```js
const validation = await validator.validate({
  exercise: toLearnerExercise(exercise),
  trustedValidationMetadata: validationMetadata,
  studentSql: "SELECT ...",
});
```

Somente o nome `trustedValidationMetadata` é aceito. Campos alternativos ou
metadata embutida no payload público são rejeitados pela forma estrita da API.

## Contrato de saída

```text
status
correct
execution
expected_summary
actual_summary
mismatches[]
constraints[]
plan_evidence
validator_policy_version = result-validator-policy-v1
```

Statuses:

```text
correct
incorrect_result
wrong_columns
wrong_row_count
ordering_mismatch
constraint_violation
execution_error
security_violation
timeout
reference_validation_error
```

O contrato não contém `reference_query`, solução, stack trace, credenciais ou
resultado esperado linha a linha. `execution` contém somente a evidência já
sanitizada do aluno.

## Comparação de resultados

- `RESULT_SET`: compara multiset normalizado; ignora ordem e preserva
  duplicatas.
- `ORDERED_RESULT`: exige o mesmo multiset na mesma sequência.
- `PROPERTY_BASED`: valida colunas, contagem opcional e propriedades declaradas,
  sem exigir uma query de referência.
- `PLAN_CONSTRAINT`: pode comparar resultado e valida somente propriedades do
  plano explicitamente declaradas.

Valores possuem canonicalização tipada para `NULL`, número, string, boolean,
date, timestamp, array e objeto. Colunas/aliases são comparados na ordem
declarada. Resultado vazio e truncamento são tratados explicitamente.

## Constraints suportadas

### AST / estrutura

Reutilizam a AST aprovada por `SqlPolicy`; não há parser SQL paralelo:

```text
query.has_join
query.has_group_by
query.has_window_function
query.has_order_by
query.has_cte
query.has_subquery
query.has_aggregate
query.has_where
query.has_having
query.has_distinct
```

### Resultado

```text
result.row_count
result.columns
result.column:<alias>.null_count
result.column:<alias>.distinct_count
result.column:<alias>.min
result.column:<alias>.max
result.column:<alias>.values
```

### Plano B06

```text
plan.node_type
plan.root.node_type
plan.node_types
plan.index_names
plan.relation_names
plan.uses_index
plan.max_total_cost
plan.max_plan_rows
```

Operadores: `equals`, `not_equals`, `contains`, `not_contains`, `at_least`,
`at_most`, `greater_than` e `less_than`.

Uma query pode produzir o mesmo resultado por coincidência e ainda ser rejeitada
se não possuir o JOIN, GROUP BY, window function, ordenação ou propriedade de
plano exigida.

## Reference query

`RESULT_SET` e `ORDERED_RESULT` exigem referência. `PROPERTY_BASED` não a executa.
`PLAN_CONSTRAINT` usa a referência somente quando fornecida para confirmar a
semântica do resultado. Sintaxe inválida, violação de segurança, erro PostgreSQL,
colunas incompatíveis, contagem incoerente ou truncamento são classificados como
`reference_validation_error`, antes de executar a submissão do aluno.

