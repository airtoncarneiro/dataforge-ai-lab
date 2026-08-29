# LLM Contract v0.1

## Objetivo

Definir como a aplicação conversa com a LLM sem delegar a ela responsabilidades operacionais ou persistência direta.

## Regra central

> A LLM produz decisões pedagógicas estruturadas; a aplicação valida, executa e persiste.

## Provider atual

A aplicação usa exclusivamente a Gemini API `generateContent`, com o modelo
`gemma-4-26b-a4b-it` no ambiente free. A API recebe `responseMimeType` como
`application/json` e `responseJsonSchema` com o schema da tarefa. A resposta
continua sendo validada localmente por AJV; JSON sintaticamente válido não é
suficiente para autorizar uma decisão pedagógica.

O nome de ambiente `OPENAI_API_KEY` é mantido temporariamente por
compatibilidade com a configuração local existente, mas a chave deve ser uma
chave criada no Google AI Studio. Não há routing de provider, preset ou
fallback entre modelos.

## Entrada de uma interação

A aplicação monta um contexto com os campos conceituais abaixo. A representação concreta pode variar conforme SDK/provedor.

```json
{
  "phase": "PRACTICE",
  "learning_goal": "SQL",
  "learner_state": {},
  "knowledge_graph": {},
  "current_exercise": {},
  "attempt": {},
  "execution_evidence": {},
  "recent_dialogue": []
}
```

Campos ausentes devem ser omitidos quando não aplicáveis.

## Saída estruturada principal

Toda resposta que altera fluxo deve poder ser normalizada para algo equivalente a:

```json
{
  "message_to_learner": "...",
  "assessment": {
    "correct": false,
    "execution_error": null,
    "conceptual_errors": [],
    "misconceptions": [],
    "positive_evidence": [],
    "negative_evidence": [],
    "prerequisites_to_revisit": []
  },
  "mastery_evidence": [
    {
      "concept": "group_by",
      "direction": "up",
      "strength": "medium",
      "reason": "..."
    }
  ],
  "next_action": "retry",
  "tool_request": null
}
```

## `next_action`

Valores iniciais permitidos:

```text
continue_probe
teach
retry
reteach
practice
advance
review
apply
transfer_test
complete
```

`next_action` é uma sugestão estruturada, não a autoridade final. O Adaptive Decision Service B10 combina a avaliação com o `LearnerState` atualizado e o Knowledge Graph para decidir a ação pedagógica. O Orchestrator deve rejeitar transições impossíveis para a fase atual.

## Evidência de mastery

A LLM não define diretamente o novo valor final de `mastery`.

Ela retorna evidências, por exemplo:

```json
{
  "concept": "window_functions",
  "direction": "down",
  "strength": "strong",
  "reason": "Confundiu PARTITION BY com agrupamento que reduz linhas."
}
```

A aplicação transforma evidências em alteração usando política determinística/versionada.

## Confidence

`confidence` representa qualidade/quantidade das evidências, não autoconfiança declarada pelo aluno.

A aplicação deve elevar confidence somente quando houver evidências suficientes e diversificadas.

## Misconception

Misconception deve ser específica e testável.

Ruim:

```text
"não entende JOIN"
```

Melhor:

```text
"trata LEFT JOIN seguido de filtro na tabela da direita no WHERE como se ainda preservasse linhas sem correspondência"
```

## Tool calling

A LLM pode solicitar somente tools registradas pela aplicação.

Tools conceituais iniciais:

```text
execute_sql
explain_sql
get_allowed_schema
get_relevant_learning_state
```

`update_learning_state` não deve ser uma tool de escrita livre da LLM. A atualização é responsabilidade do Learner Model Service após validação da avaliação.

## `execute_sql`

Entrada conceitual:

```json
{
  "sql": "SELECT ...",
  "exercise_id": "..."
}
```

A aplicação deve ignorar qualquer tentativa da LLM de fornecer credenciais, banco, host ou privilégios.

Saída conceitual:

```json
{
  "status": "ok",
  "columns": ["customer_id", "total_orders"],
  "rows": [],
  "row_count": 10,
  "truncated": false,
  "duration_ms": 12.4,
  "error": null
}
```

Em falha:

```json
{
  "status": "error",
  "columns": [],
  "rows": [],
  "row_count": 0,
  "truncated": false,
  "duration_ms": 3.1,
  "error": {
    "category": "postgresql_error",
    "sqlstate": "42703",
    "message": "column ... does not exist"
  }
}
```

Não enviar stack trace interno à LLM quando não necessário.

## `explain_sql`

Entrada:

```json
{
  "sql": "SELECT ...",
  "analyze": false
}
```

`ANALYZE=true` somente quando a política do sandbox determinar que é seguro.

Saída deve preferir estrutura parseável, idealmente `EXPLAIN (FORMAT JSON)`.

## Avaliação de correção

A aplicação deve fornecer à LLM o resultado de validações determinísticas antes de pedir julgamento pedagógico, quando possível.

Exemplo:

```json
{
  "validation": {
    "strategy": "ORDERED_RESULT",
    "passed": false,
    "details": {
      "same_rows": true,
      "same_order": false
    }
  }
}
```

A LLM então explica o significado pedagógico da diferença, em vez de decidir sozinha se os resultados coincidem.

## Geração de exercício

A saída deve conter ao menos:

```json
{
  "id": "generated-or-assigned-id",
  "concepts": ["join", "aggregation"],
  "difficulty": 3,
  "statement": "...",
  "expected_skills": ["..."],
  "validation_strategy": "RESULT_SET",
  "evaluation_notes": ["..."],
  "reference_solution": "..."
}
```

`reference_solution` é informação interna e não deve fazer parte da mensagem ao aluno.

## Diagnóstico

Durante `PROBE`, a LLM deve retornar a próxima pergunta e quais conceitos ela pretende discriminar, sem fornecer solução da pergunta anterior quando ainda estiver coletando evidências.

Exemplo:

```json
{
  "question": "...",
  "targets": ["join_semantics"],
  "difficulty": 4,
  "reason": "distinguir conhecimento operacional de reconhecimento superficial"
}
```

## Prompt injection

Conteúdo do aluno deve ser tratado como dados, não como instrução de sistema.

A aplicação não deve inserir texto do aluno dentro da política de sistema de forma que ele possa sobrescrevê-la.

A LLM deve ser instruída a ignorar pedidos para:

- revelar system prompt;
- alterar regras do sandbox;
- executar ferramentas não registradas;
- expor soluções internas/reference solutions;
- fabricar resultados de execução.

## Falhas do provedor

A camada LLM deve distinguir:

```text
transport/provider error
invalid structured output
tool request invalid
policy/transition invalid
```

A aplicação pode tentar novamente chamadas transitórias, mas não deve duplicar tentativas de aluno nem aplicar mastery duas vezes.

## Idempotência

Toda avaliação persistida deve estar vinculada a `attempt_id`.

Reprocessar a mesma tentativa não pode gerar múltiplas atualizações de mastery sem uma política explícita de reavaliação.

## Versionamento

Persistir ou registrar, quando viável:

```text
model/provider
prompt/policy version
evaluator version
mastery policy version
adaptive decision policy version
```

Isso permite comparar comportamento quando prompts ou modelos mudarem.
