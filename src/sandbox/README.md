# SQL Sandbox — B04

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

## Limite desta entrega

O retorno contém a estrutura mínima de sucesso ou erro necessária a B04. Normalização completa de evidências, duração e SQLSTATE pertence a B05. `EXPLAIN` pertence a B06 e permanece bloqueado.
