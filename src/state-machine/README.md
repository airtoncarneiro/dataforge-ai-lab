# Tutor State Machine — B14

`learning-flow-policy-v1` controla somente o lifecycle pedagógico. O módulo não
gera conteúdo, não chama LLM, não executa SQL, não calcula mastery, não gera
exercícios e não persiste estado.

## Fases e status

Fases: `PROBE`, `PLAN`, `TEACH`, `PRACTICE`, `EVALUATE`, `ADAPT`, `REVIEW`,
`APPLY`, `TRANSFER_TEST` e `COMPLETED`.

Status: `active`, `error` e `completed`. Uma falha preserva a fase; somente
`resume_requested` sobre erro retryable volta ao status ativo.

## Transições pedagógicas

| Origem | Evento | Destino |
| --- | --- | --- |
| PROBE | probe_completed | PLAN |
| PLAN | plan_ready | TEACH |
| TEACH | teaching_completed | PRACTICE |
| PRACTICE | exercise_ready | PRACTICE |
| PRACTICE | answer_submitted | EVALUATE |
| EVALUATE | evaluation_completed | ADAPT |
| ADAPT | retry_requested | PRACTICE |
| ADAPT | reteach_requested | TEACH |
| ADAPT | practice_requested | PRACTICE |
| ADAPT | advance_requested | TEACH |
| ADAPT | review_requested | REVIEW |
| REVIEW | review_completed | PRACTICE |
| ADAPT/REVIEW | apply_ready | APPLY |
| APPLY | apply_completed | EVALUATE |
| ADAPT | transfer_test_ready | TRANSFER_TEST |
| TRANSFER_TEST | transfer_test_completed | EVALUATE |
| EVALUATE | learning_completed | COMPLETED |

`failure` mantém a fase e muda o status para `error`; `resume_requested` mantém
a fase e restaura `active` quando a falha é retryable.

## Autoridades

B10 continua decidindo `retry`, `reteach`, `practice`, `advance` ou `review`.
`applyAdaptiveDecision` valida o contrato `adaptive-policy-v1`, converte a ação
em evento e deixa B14 aceitar ou rejeitar a transição na fase atual. A LLM não
é uma entrada da State Machine.

`applyProbeSession` valida o contrato B13. PROBE concluído avança a `PLAN`;
PROBE com erro registra `failure` em `PROBE`; PROBE ainda ativo é rejeitado.

Guards críticos exigem readiness estruturada para Apply/Transfer Test, ciclo
Apply já avaliado antes do Transfer Test e conclusão imediatamente após um
Transfer Test, com evidências explícitas. Retries adaptativos são limitados ao
mesmo máximo de B10.
