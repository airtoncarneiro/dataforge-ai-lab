# Exercise generation/selection — B15

Este módulo gera um exercício SQL estruturado e o valida antes que qualquer
conteúdo seja apresentado ao aluno. Ele não executa SQL, não avalia respostas,
não altera `mastery` e não aplica transições da state machine.

## Fronteiras

- B09 confirma que o conceito existe, está disponível e não possui lacunas de
  pré-requisito.
- B10 pode autorizar `practice`, `advance` ou `review`; a decisão é somente
  consumida e nunca recalculada ou alterada.
- B12 compõe a policy e o menor recorte útil de Learner Model/Knowledge Graph.
- B11 exige Structured Output e isola o provider real do fake determinístico.
- B15 escolhe a dificuldade e valida deterministicamente a proposta.
- B16, ainda não implementado, usará a metadata trusted para validar a SQL do
  aluno com evidências do Sandbox.

## API

```js
const result = await exerciseService.generate({
  currentConcept: "join",
  learnerState,
  targetDifficulty: "medium",
  pedagogicalContext: {
    phase: "PRACTICE",
    learning_goal: learnerState.learning_goal,
    integration_concepts: [],
    scenario_hint: "Use customers e orders.",
    recent_messages: [],
  },
  adaptiveDecision,
});
```

O resultado de sucesso contém:

```text
status
exercise                    # contrato B07; reference_solution é sempre null
validation_metadata         # trusted, nunca enviar ao aluno
attempts
policy_version              # exercise-policy-v1
error                       # null
```

Use `toLearnerExercise(result.exercise)` para obter o payload público. Essa
projeção inclui somente `id`, `concepts`, `difficulty`, `objective`, `statement`,
`expected_skills`, `validation_strategy` e `created_at`. Ela não contém
`reference_solution`, `reference_query`, `evaluation_notes` ou metadata interna.

## Difficulty

`targetDifficulty` aceita `low`, `medium` ou `high`. A aplicação transforma o
alvo em uma difficulty inteira de 1 a 5 e a limita pela faixa do conceito atual:

```text
mastery < 0.50                         -> 1..2
0.50 <= mastery < 0.80                 -> 2..4
mastery >= 0.80 e confidence low       -> 3..4
mastery >= 0.80 e confidence medium/high -> 4..5
```

Assim, mastery baixo não introduz complexidade avançada e domínio operacional
não recebe exercício trivial. `integration_concepts` somente aceita conceitos
já dominados operacionalmente.

## Validation metadata trusted

```text
expected_columns
comparison_mode
ordering_required
expected_row_count
reference_query
concepts_evaluated
source_relations
constraints[] { kind, target, operator, value }
```

`RESULT_SET` e `ORDERED_RESULT` exigem uma `reference_query`. A query é analisada
pela mesma policy read-only do Sandbox, mas nunca executada em B15. Para
`PROPERTY_BASED`, ao menos uma constraint é obrigatória. `PLAN_CONSTRAINT` exige
conceito de índices/EXPLAIN/otimização e uma constraint `plan_property`.

## Regeneration

Saída incompatível com o JSON Schema ou rejeitada pelas validações
determinísticas pode gerar nova chamada, até `maxGenerationAttempts` (padrão 3,
máximo 5). Timeout, autenticação e erro do provider não abrem um segundo ciclo
de retry além do controle técnico de B11. Ao esgotar o limite, o serviço retorna
erro estruturado e sanitizado, sem conservar o payload inválido.

