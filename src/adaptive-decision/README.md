# Adaptive Decision Policy

Este módulo implementa `adaptive-policy-v1`, uma política determinística que escolhe a próxima ação após uma `Evaluation`. Ele recebe o `LearnerState` já atualizado pelo Learner Model Service quando aplicável, a avaliação, o `KnowledgeGraph`, o conceito atual e o número de retries técnicos consecutivos.

O `next_action` sugerido dentro de `Evaluation` não é autoridade para a decisão. A política o valida como parte do contrato de B07, mas calcula a ação usando o estado objetivo e as evidências estruturadas.

Este componente corresponde oficialmente a B10 — Adaptive Decision Service. A integração com LLM começa em B11 — LLM Adapter e não faz parte deste módulo.

## Contrato de entrada

```js
{
  learner_state,
  evaluation,
  knowledge_graph,
  current_concept: "group_by",
  retry_count: 0
}
```

`retry_count` representa quantas decisões `retry` consecutivas já foram emitidas para o mesmo fluxo técnico. O padrão é `0`; o chamador deve incrementá-lo a cada retry e reiniciá-lo após execução bem-sucedida, mudança de conceito ou mudança de estratégia. A política permite no máximo dois retries consecutivos.

## Contrato de saída

```json
{
  "action": "advance",
  "current_concept": "select",
  "next_concept": "where",
  "reason_codes": [
    "operational_mastery",
    "prerequisites_satisfied"
  ],
  "rationale": "Domínio operacional confirmado; where é o primeiro candidato disponível pela ordem do grafo.",
  "blocking_prerequisites": [],
  "policy_version": "adaptive-policy-v1"
}
```

As únicas ações produzidas são `retry`, `reteach`, `practice`, `advance` e `review`. `next_concept` é obrigatório somente para `advance`. Cada bloqueio contém:

```json
{
  "target_concept": "join",
  "concept": "null",
  "reason": "mastery_below_threshold",
  "mastery": 0.79,
  "confidence": "high"
}
```

## Ordem da política

1. Erro técnico isolado, sem erro conceitual ou misconception ativa: `retry`.
2. Limite de retry atingido: `reteach` quando mastery é insuficiente; caso contrário `practice`.
3. Misconception confirmada: `reteach`.
4. Erro conceitual: `reteach` abaixo de `0.50`; caso contrário `practice`.
5. Misconception suspeita: `reteach` abaixo de `0.50`; caso contrário `practice`.
6. Mastery abaixo de `0.50`: `reteach`.
7. Mastery entre `0.50` e `0.79`: `practice`.
8. Mastery a partir de `0.80` com `confidence: low`: `practice`.
9. Domínio operacional: `advance` para candidato com pré-requisitos satisfeitos.
10. Sem candidato disponível: `review`.

Na seleção de avanço, dependentes diretos disponíveis do conceito atual têm prioridade. Empates usam a ordem topológica determinística do grafo. Se não houver dependente direto disponível, o primeiro conceito disponível do grafo é escolhido. Conceitos bloqueados nunca são selecionados.

## Reason codes

| Code | Significado |
| --- | --- |
| `isolated_execution_error` | Falha técnica sem evidência conceitual adversa. |
| `retry_limit_reached` | Limite de retries consecutivos atingido. |
| `conceptual_error` | A avaliação contém erro conceitual. |
| `confirmed_misconception` | Há misconception confirmada ativa. |
| `suspected_misconception` | Há misconception suspeita ativa. |
| `mastery_insufficient` | Mastery está abaixo de `0.50`. |
| `mastery_partial` | Mastery está entre `0.50` e `0.79`. |
| `confidence_insufficient` | Mastery atingiu `0.80`, mas confidence ainda é `low`. |
| `operational_mastery` | Mastery e confidence permitem avanço. |
| `prerequisites_satisfied` | O conceito selecionado está disponível pelo grafo. |
| `blocked_prerequisites` | Há candidato ou conceito bloqueado por lacunas. |
| `no_available_concept` | Nenhum conceito pode ser selecionado para avanço. |

A política não altera mastery/confidence, não produz conteúdo ou exercícios e não implementa persistência, LLM ou Orchestrator.
