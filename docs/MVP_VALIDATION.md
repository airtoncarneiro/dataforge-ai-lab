# Validação do MVP

Data da validação: 2026-08-29.

## Evidências executadas

- `npm test`: 309 testes aprovados.
- PostgreSQL local iniciado com `npm run db:up` e migração B19 aplicada.
- `npm run test:integration` com o `.env` carregado: 71 testes aprovados.
- Sessão demo roteirizada: PROBE, PLAN, TEACH, PRACTICE, execução SQL real,
  avaliação, atualização do Learner Model e próxima ação `practice`.
- `npm run eval:live` com Gemma 4 31B: 8/8 fixtures aprovados, 8 JSONs válidos,
  nenhuma falha de provider e nenhum vazamento de solução.

## Critérios de aceite

| Critério | Evidência |
| --- | --- |
| CA-01 | PROBE iniciado antes do ensino na sessão demo e nos testes B13. |
| CA-02 | Learner Model estruturado e atualizado; testes B08/B13. |
| CA-03 | Exercício compatível com o estado; testes B15 e sessão demo. |
| CA-04 | SQL válida executada no PostgreSQL; integração e sessão demo. |
| CA-05 | Erros reais diferenciados; testes B16 e sandbox. |
| CA-06 | Comandos proibidos bloqueados; testes adversariais B26. |
| CA-07 | MasteryChange persistido com evidência; testes B08/B19. |
| CA-08 | Próxima ação adaptativa determinada por evidência; testes B10/B18. |
| CA-09 | Fluxo completo executado no terminal; teste B18 e sessão demo. |
| CA-10 | 309 testes unitários e 71 testes de integração aprovados. |

## Observação operacional

O teste live depende do comportamento do provider Google e pode apresentar
intermitência. A aplicação mantém validação local do schema e retries limitados;
os testes automatizados continuam determinísticos e não dependem da API externa.
