# Knowledge Dependency Graph

Este módulo representa conceitos de SQL como um grafo direcionado acíclico. Uma dependência `A -> B` significa que `A` é pré-requisito de `B`; a ordem declarada dos nós é usada apenas como desempate para produzir resultados determinísticos.

## Validação estrutural

`KnowledgeGraph` rejeita:

- grafo vazio ou com formato inválido;
- identificadores fora do padrão `snake_case`;
- conceitos ou pré-requisitos duplicados;
- referências a conceitos inexistentes;
- ciclos entre conceitos.

Os nós, as listas e os resultados públicos são imutáveis. Consultas que recebem um `LearnerState` o validam pelos contratos de domínio de B07 e não o modificam.

## Operações públicas

- `getConcept` e `getConcepts`;
- `getDirectPrerequisites` e `getTransitivePrerequisites`;
- `getDirectDependents` e `getTransitiveDependents`;
- `getRootConcepts`;
- `isOperationallyMastered`;
- `getAvailableConcepts` e `getBlockedConcepts`;
- `getPrerequisiteGaps`, com busca transitiva por padrão;
- `toJSON`.

Um conceito é considerado operacionalmente dominado quando tem `mastery >= 0.80` e `confidence` diferente de `low`. Portanto, `medium` e `high` satisfazem o requisito de confiança desta camada. Estado ausente, `mastery` abaixo do limite e `confidence: low` geram lacunas com motivos distintos.

Um conceito ainda não dominado está disponível quando não possui nenhuma lacuna transitiva de pré-requisito. Está bloqueado quando possui pelo menos uma. Conceitos já dominados não aparecem em nenhuma das duas listas. Essa classificação é apenas estrutural: ela não altera `mastery` ou `confidence`, não escolhe uma ação pedagógica e não prioriza exercícios.

## Grafo SQL inicial

O grafo `sql-knowledge-graph-v1` contém estas dependências diretas:

| Conceito | Pré-requisitos |
| --- | --- |
| `select` | nenhum |
| `where` | `select` |
| `order_by` | `select` |
| `null` | `select` |
| `case` | `select`, `null` |
| `aggregate_functions` | `select` |
| `group_by` | `aggregate_functions` |
| `having` | `group_by`, `where` |
| `join` | `select`, `null` |
| `subqueries` | `select`, `where` |
| `cte` | `subqueries` |
| `window_functions` | `select`, `aggregate_functions`, `order_by` |
| `date_time` | `select`, `where` |
| `indexes` | `where`, `order_by`, `join` |
| `explain` | `select`, `join`, `aggregate_functions` |
| `query_optimization` | `indexes`, `explain` |

O grafo é uma configuração estática e versionada. Persistência, seleção adaptativa, geração de exercícios, integração com LLM e Orchestrator permanecem fora de B09.
