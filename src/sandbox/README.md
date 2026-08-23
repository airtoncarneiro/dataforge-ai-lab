# SQL Sandbox — B04/B05

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

`EXPLAIN` pertence a B06 e permanece bloqueado.
