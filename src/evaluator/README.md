# Evaluator B17

O Evaluator transforma o resultado objetivo do Result Validator B16 em uma
`Evaluation` pedagógica B07. Ele combina a Tutor Policy B12, o LLM Adapter B11
e regras locais de reconciliação, sem executar SQL, alterar mastery ou decidir
a progressão final.

## Fronteira de autoridade

B16 é authoritative para:

- `status` e `correct`;
- status/erro da execução;
- `mismatches`;
- constraints estruturais e de plano;
- evidência de `EXPLAIN`.

A LLM pode sugerir somente:

- nível de compreensão e qualidade do raciocínio;
- erros conceituais e misconceptions;
- evidências pedagógicas e `MasteryEvidence`;
- feedback socrático e hints graduais;
- `suggested_next_action` entre as ações conhecidas por B10.

O schema enviado ao B11 não possui campos de correção ou execução. Campos
extras são rejeitados por Structured Outputs. A reconciliação local ainda
restringe conceitos ao exercício, prerequisites ao Knowledge Graph, força da
evidência aos fatos B16 e sugestões de ação ao resultado observado.

## Interface

```js
const result = await evaluator.evaluate({
  exercise,
  attempt,
  validationResult,
  learnerState,
  evaluatedConcepts,
  recentMessages,
});
```

O `KnowledgeGraph`, o `TutorPolicyContextBuilder` e o `LlmAdapter` são
dependências injetadas no serviço. `exercise` pode ser o contrato público B15
ou o contrato interno B07; em ambos os casos, somente a projeção pública é
enviada à LLM. `reference_solution` e `reference_query` nunca entram no
contexto.

## Contrato retornado

O envelope versionado por `evaluator-policy-v1` contém:

```text
evaluation                 contrato Evaluation B07
objective_assessment       projeção imutável dos fatos B16
pedagogical_assessment     interpretação LLM ou fallback identificado
execution_error            projeção do Assessment
conceptual_errors
misconceptions
evidence                   positive / negative evidence
feedback
hints
mastery_evidence           evidência para B08, nunca score final
suggested_next_action      sugestão; B10 continua authoritative
provenance                 IDs e versões B12/B16/B17 + LLM request id
evaluator_policy_version
```

## Reconciliação

- erro técnico isolado não gera misconception nem evidência de mastery;
- `correct=true` aceita somente evidência `up`; `strong` exige constraint
  estrutural/de plano satisfeita e nunca é inferido automaticamente;
- resultado incorreto não pode ser promovido a correto ou `advance`;
- constraint estrutural falha pode gerar erro conceitual determinístico no
  conceito correspondente;
- misconception sugerida recebe ID próprio e referência para a evidência que a
  sustenta;
- solução SQL completa em feedback/hint é rejeitada;
- B08 continua sendo o único componente que aplica `MasteryEvidence`;
- B10 continua sendo o único componente que decide a ação final.

## Fallback

Timeout, erro do provider, schema inválido, contradição ou violação da política
da resposta não apagam B16. O serviço retorna uma `Evaluation` conservadora,
marca `pedagogical_assessment.source` como `deterministic_fallback`, registra o
erro público sanitizado e preserva toda evidência objetiva disponível.
