# Tutor Policy integration — B12

`docs/TUTOR_POLICY.md` permanece a fonte conceitual. `loadTutorPolicy()` lê esse documento, valida versão e princípios essenciais, separa suas seções e produz uma representação operacional imutável com fingerprint SHA-256.

O builder seleciona apenas responsabilidades compartilhadas e seções relevantes para a fase atual. Ele não concatena o documento inteiro e não implementa o fluxo da fase.

```js
import {
  createTutorPolicyContextBuilder,
} from "./index.js";

const builder = await createTutorPolicyContextBuilder();
const request = builder.build({
  phase: "EVALUATE",
  learningGoal: "SQL",
  relevantConcepts: ["join"],
  learnerState,
  knowledgeGraph,
  currentExercise,
  attempt,
  executionEvidence,
  recentMessages,
  tools,
});

const result = await adapter.generate(request);
```

## Separação do request

- `instructions`: policy estática, versão, ciclo, responsabilidade da fase e limites de autoridade;
- primeira `message`: envelope JSON `application_context`, com slice dinâmico mínimo;
- demais `messages`: diálogo recente `user`/`assistant`, nunca interpolado nas instructions;
- `outputSchema`: schema estrito específico da tarefa inferida pela fase;
- `tools`: subconjunto das tools registradas que é pertinente à fase.

O slice do LearnerState omite IDs internos, timestamps e evidence IDs. O Knowledge Graph contém somente conceitos focais e seus pré-requisitos transitivos. `reference_solution` nunca é enviado. Exercício, tentativa e evidência de execução só entram nas fases em que são necessários.

## Autoridade

- a LLM sugere `MasteryEvidence`; B08 calcula mastery/confidence;
- a LLM sugere `next_action`; B10 decide progressão após avaliação;
- somente o SQL Sandbox executa SQL e produz evidência objetiva;
- o builder não executa tools, não persiste estado e não aplica transições.

## Versão

Versão operacional: `tutor-policy-v0.1`, coerente com o título de `docs/TUTOR_POLICY.md`. O fingerprint identifica exatamente o conteúdo carregado sem copiá-lo para outros módulos.

B13 ainda deverá implementar a dinâmica do diagnóstico PROBE. B12 apenas torna sua policy e seu schema disponíveis para composição futura.
