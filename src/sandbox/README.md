# SQL Sandbox — B04/B05/B06

O sandbox trata SQL do aluno como entrada hostil e permite somente consultas de leitura compatíveis com o dataset educacional.

## Camadas de proteção

1. `SqlPolicy` converte a entrada em AST PostgreSQL, exige uma única statement e aceita somente `SELECT`, `UNION` e CTEs de leitura.
2. Relações e funções passam por allowlists. CTEs são validadas respeitando o escopo em que seus nomes existem.
3. A SQL aprovada é serializada novamente a partir do AST; o texto original não é executado.
4. A conexão usa a role fixa `mentor_sandbox`, confirmada por `current_user` antes da consulta do aluno.
5. A execução acontece em `BEGIN READ ONLY`, com `SET LOCAL statement_timeout` e `search_path` restrito.
6. A consulta é envolvida por um limite de `maxRows + 1`, permitindo informar truncamento sem materializar resultado ilimitado.
7. Toda execução termina com `ROLLBACK`; uma conexão cujo rollback falhe é destruída.

Regex participa apenas da classificação amigável de comandos que o parser não reconhece. Ela não concede permissão nem é usada como única barreira de segurança.

## Contrato de Execution Evidence

Cada chamada retorna os mesmos campos, tanto em sucesso quanto em erro:

```json
{
  "status": "ok",
  "columns": ["customer_id"],
  "rows": [{ "customer_id": 1 }],
  "row_count": 1,
  "truncated": false,
  "duration_ms": 2.315,
  "error": null
}
```

Em falha, `error` contém somente `category`, `sqlstate` e mensagem sanitizada. O SQLSTATE é `null` quando não existe erro PostgreSQL correspondente; erros de sintaxe detectados antes do banco usam o código canônico `42601` sem executar a SQL do aluno.

`duration_ms` mede, com relógio monotônico, a chamada completa do sandbox: política, aquisição/verificação da conexão, execução única da SQL e rollback. `row_count` representa a quantidade de linhas efetivamente devolvidas, não uma segunda contagem sobre o resultado completo.

## Contrato de EXPLAIN

`SqlSandbox.explain(sql)` recebe a SQL de leitura sem o prefixo `EXPLAIN`. A entrada passa pela mesma `SqlPolicy` usada por `execute()` e somente depois da aprovação o backend constrói `EXPLAIN (FORMAT JSON, ANALYZE FALSE)`.

O retorno tem forma fixa em sucesso e erro:

```json
{
  "status": "ok",
  "analyze": false,
  "plan": {
    "node_type": "Index Scan",
    "relation_name": "customers",
    "index_name": "customers_pkey",
    "startup_cost": 0.15,
    "total_cost": 8.17,
    "plan_rows": 1,
    "plan_width": 36,
    "subplan_name": null,
    "plans": []
  },
  "planning_time_ms": 0.214,
  "execution_time_ms": null,
  "duration_ms": 2.315,
  "error": null
}
```

`plans` contém os filhos e subplans normalizados recursivamente. Campos opcionais do PostgreSQL são representados por `null`, sem alterar a forma do contrato. Em erro, `plan` e os tempos do PostgreSQL são `null`, e `error` usa as mesmas categorias e mensagens sanitizadas de Execution Evidence.

A geração do plano mantém a role `mentor_sandbox`, a transação read-only, o `statement_timeout`, o `search_path`, o rollback e a higiene do pool. Apenas uma statement é enviada para gerar o plano; a SQL original não é executada separadamente.

SQL iniciada por `EXPLAIN` continua proibida como entrada do aluno. `EXPLAIN ANALYZE` executaria a consulta e, por isso, é uma operação distinta: B06 não o habilita, `analyze: true` retorna `security_violation` sem abrir conexão, e `execution_time_ms` permanece `null`. A interpretação pedagógica do plano e qualquer uso de LLM permanecem fora deste componente.
