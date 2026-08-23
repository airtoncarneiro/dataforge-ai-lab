# Domínio pedagógico — B07

Esta camada contém os contratos centrais compartilhados pelo Orchestrator, Evaluator, Exercise Service e futuro Learner Model Service. Ela não importa o SQL Sandbox, não chama LLM, não persiste dados e não calcula mudanças de mastery.

## Contratos

| Contrato | Responsabilidade |
| --- | --- |
| `LearningSession` | Identificar objetivo, fase e referências ao estado/exercício atual. |
| `ConceptState` | Representar mastery, confidence, misconceptions e evidências de um conceito. |
| `LearnerState` | Agregar os estados conceituais de uma sessão. |
| `Exercise` | Registrar conceitos-alvo, objetivo, dificuldade e estratégia de validação. |
| `Attempt` | Registrar uma submissão imutável e sua relação com sessão/exercício. |
| `ExecutionEvidence` | Guardar um snapshot JSON-safe da evidência objetiva do executor. |
| `Assessment` | Separar correção, erro de execução, erros conceituais e evidências pedagógicas. |
| `Evaluation` | Associar assessment, feedback, evidências de mastery e próxima ação a uma tentativa. |
| `MasteryEvidence` | Sugerir direção e força de uma evidência, sem definir novo mastery. |
| `MasteryChange` | Representar uma mudança já decidida por política externa e sua rastreabilidade. |

`Misconception`, `ConceptualError`, `EvaluationEvidence`, `EvidenceDetail`, `ExecutionError` e `Feedback` evitam campos booleanos ou texto sem contexto para informações que exigem estrutura.

## Uso

As factories validam a entrada, aplicam defaults explícitos, copiam dados JSON dinâmicos e devolvem objetos profundamente congelados:

```js
import { createConceptState } from "./src/domain/index.js";

const state = createConceptState({
  id: "concept-state-select",
  concept: "select",
  created_at: "2026-08-23T12:00:00.000Z",
  updated_at: "2026-08-23T12:00:00.000Z",
});
```

O resultado inclui `mastery: 0`, `confidence: "low"`, `misconceptions: []` e `evidence_ids: []`. IDs e timestamps não são gerados implicitamente: o chamador deve fornecê-los para manter idempotência e auditabilidade. Timestamps usam a forma UTC canônica produzida por `Date.prototype.toISOString()`.

## Enums e invariantes

- `mastery`: número finito inclusivo entre `0` e `1`;
- `confidence`: `low`, `medium` ou `high`;
- `next_action`: somente os valores definidos em `docs/LLM_CONTRACT.md`;
- fases: os estados definidos no fluxo do Orchestrator;
- validation strategy: `RESULT_SET`, `ORDERED_RESULT`, `PROPERTY_BASED`, `PLAN_CONSTRAINT` ou `MANUAL_LLM_REVIEW`;
- SQLSTATE: `null` ou código PostgreSQL de cinco caracteres;
- referências de tentativa/evidência são preservadas para auditoria.

`reference_solution` é um campo interno do exercício e não autoriza sua exibição ao aluno.

## Structured Outputs

`schemas.js` exporta JSON Schemas com campos requeridos, enums e `additionalProperties: false` para os objetos pedagógicos. `DOMAIN_SCHEMAS.Evaluation` pode servir como base para a integração futura, mas B07 não contém adapter, prompt ou chamada à LLM.

Os schemas descrevem objetos já normalizados. Defaults pertencem às factories e são materializados antes de persistência ou serialização.
