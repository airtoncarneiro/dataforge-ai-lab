# B22 — Review Scheduler

O scheduler é determinístico e não altera `mastery`. Quando B10 encaminha o
fluxo para `REVIEW`, ele mantém o conceito atual e acrescenta até dois conceitos
anteriores que tenham domínio operacional, evidência registrada e nenhuma
misconception ativa. A prioridade é pelo estado atualizado há mais tempo.

O orquestrador usa esses alvos para gerar um único exercício de recuperação
ativa na fase `REVIEW`; B15 continua responsável pela geração e B16/B17/B08/B10
continuam sendo as autoridades de validação, avaliação, atualização e decisão.
