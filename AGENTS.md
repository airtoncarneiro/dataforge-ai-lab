# AGENTS.md

## Missão

Implementar o MVP do DataForge AI Lab: um tutor adaptativo de SQL que avalia respostas usando execução real e controlada em PostgreSQL.

Leia antes de alterar código:

1. `docs/MVP_SPEC.md`
2. `docs/ARCHITECTURE.md`
3. `docs/LLM_CONTRACT.md`
4. `docs/TUTOR_POLICY.md`
5. `docs/BACKLOG.md`

Em conflito, a prioridade é: instrução explícita do usuário > `MVP_SPEC.md` > `ARCHITECTURE.md` > este arquivo > demais documentos.

## Princípios obrigatórios

- A LLM é responsável por decisões pedagógicas, não por segurança operacional.
- Nunca conceder à LLM conexão direta, credenciais de banco ou execução de shell.
- Toda SQL do aluno passa por um executor/sandbox determinístico.
- Não considerar texto produzido pela LLM evidência de que uma query executou corretamente.
- Resultado, erro, metadados e `EXPLAIN` do PostgreSQL são evidências do executor.
- O estado pedagógico deve ser estruturado e persistível.
- `mastery` não deve ser alterado apenas porque a LLM declarou um novo valor; a aplicação aplica política explícita de atualização.
- Separar erro conceitual de erro de execução.
- Não avançar o aluno apenas porque o conteúdo foi explicado.
- Não revelar imediatamente a solução de um exercício quando uma tentativa guiada ainda puder gerar aprendizado.

## Escopo do primeiro milestone

Construir o fluxo end-to-end pelo terminal. Não construir frontend web.

O milestone termina quando for possível:

1. iniciar sessão;
2. informar `Quero aprender SQL`;
3. executar diagnóstico adaptativo;
4. criar Learner Model inicial;
5. ensinar ou propor exercício;
6. receber SQL do aluno;
7. executar SQL em PostgreSQL controlado;
8. avaliar a tentativa;
9. atualizar o Learner Model;
10. escolher a próxima ação adaptativa.

## Stack

- PostgreSQL é obrigatório para execução dos exercícios.
- A integração com LLM deve usar API e respostas estruturadas/tool calling quando disponíveis.
- A linguagem/runtime da aplicação não é fixada por este documento. Não introduza migração para Python nem frontend como trabalho incidental; faça isso somente mediante instrução explícita.
- Evite frameworks de agentes/orquestração enquanto código simples e explícito for suficiente.

## Segurança do SQL sandbox

Na primeira versão:

- permitir apenas consultas de leitura necessárias aos exercícios;
- bloquear DDL, DML destrutivo, `COPY`, acesso a filesystem/rede e extensões perigosas;
- usar usuário PostgreSQL com privilégios mínimos;
- impor `statement_timeout`;
- limitar quantidade de linhas retornadas;
- impedir acesso ao banco/schema de estado da aplicação;
- não usar validação somente por regex como única barreira de segurança;
- testar tentativas de múltiplos statements e comandos proibidos.

Se um requisito pedagógico exigir DML posteriormente, implementar ambiente descartável/transacional específico; não enfraquecer o sandbox global.

## LLM

A LLM deve receber apenas o contexto necessário:

- política pedagógica;
- objetivo/sessão atual;
- Learner Model relevante;
- exercício atual;
- schema educacional permitido;
- evidências objetivas da execução;
- trecho de conversa necessário.

Evite reenviar histórico ilimitado.

Toda decisão relevante deve ser retornada de forma estruturada, incluindo `next_action` e evidências para atualização pedagógica.

## Persistência

Persistir ao menos:

- sessão;
- conceitos e domínio;
- confidence;
- misconceptions;
- exercícios apresentados;
- tentativas;
- evidências de avaliação;
- próxima ação/estado do fluxo.

O histórico deve permitir explicar por que o domínio foi atualizado.

## Qualidade

Para cada incremento:

- escrever testes para regras determinísticas;
- testar caminhos de sucesso e falha;
- não depender da LLM em testes que possam ser determinísticos;
- mockar a LLM em testes unitários;
- manter exemplos de execução reproduzíveis localmente;
- documentar novas decisões arquiteturais relevantes.

## Commits

Preferir commits pequenos e coerentes. Não misturar refatoração não relacionada com implementação de requisito.

## Definition of Done

Uma tarefa só está concluída quando:

- critérios de aceite correspondentes passam;
- testes relevantes existem e passam;
- documentação afetada foi atualizada;
- não houve expansão silenciosa de escopo;
- nenhuma proteção do sandbox foi removida para fazer um teste passar.
