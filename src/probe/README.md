# Diagnóstico PROBE — B13

O módulo executa somente o diagnóstico inicial. Ele não implementa `TEACH`, a
state machine B14, o Orchestrator completo nem persistência.

## Fronteiras

- B09 resolve os conceitos-alvo e seu fechamento de pré-requisitos.
- B12 compõe a policy e o contexto mínimo da fase `PROBE`.
- B11 formula perguntas e avalia respostas sob JSON Schemas estritos.
- B08 é o único componente que calcula `mastery` e `confidence`.
- `probe-policy-v1` escolhe conceito, dificuldade, tipo e término sem delegar
  essas decisões à LLM.

## API

```js
const session = await probeService.start({
  learningGoal: "Quero aprender SQL",
  maxQuestions: 8,
});

const nextSession = await probeService.submitAnswer(session, {
  answer: "Minha resposta aberta...",
  executionEvidence: null,
});
```

`ProbeSession` é imutável e contém `learning_goal`, `target_concepts`,
`evaluated_concepts`, `current_concept`, contadores, status, `learner_state`,
histórico auditável, razão de término e o resultado final quando concluído.

O estado provisório começa em `mastery=0.50` e `confidence=low`; cada resposta
vira `Evaluation`/`MasteryEvidence`, e B08 calcula o novo estado. A LLM nunca
retorna nem grava o score final.

## Término

O diagnóstico termina no limite configurado (sempre entre 5 e 12) ou, após a
quinta questão, quando os alvos primários estão cobertos, há evidência suficiente
para cada um e as lacunas detectadas tiveram seus pré-requisitos investigados.

Perguntas diagnósticas não possuem campos de solução, dica ou feedback. A
avaliação é interna e a mensagem registrada no contrato apenas confirma a coleta
sem ensinar a resposta. Se uma pergunta aberta contiver SQL executável, o futuro
Orchestrator deve fornecer `executionEvidence` real do Sandbox; na ausência dela,
o serviço instrui a LLM a não afirmar que a consulta foi executada.
