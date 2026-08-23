# Learner Model

O Learner Model Service aplica uma política determinística e versionada sobre os contratos de B07. Ele recebe `LearnerState` e `Evaluation`, usa apenas `MasteryEvidence`, erros conceituais e misconceptions validadas, e devolve:

```text
learner_state: novo LearnerState imutável
mastery_changes: MasteryChange[] auditável
```

A LLM nunca informa o novo mastery. O serviço também não chama LLM, não persiste dados, não consulta o Knowledge Graph e não importa o SQL Sandbox.

## Política `mastery-policy-v1`

Delta base de cada evidência:

| strength | direção `up` | direção `down` |
| --- | ---: | ---: |
| `weak` | +0.02 | -0.02 |
| `medium` | +0.05 | -0.05 |
| `strong` | +0.10 | -0.10 |

- deltas de uma avaliação são somados por conceito e limitados a `+0.12/-0.15`;
- erro conceitual adiciona `-0.02`;
- misconception nova adiciona `-0.02` (`suspected`) ou `-0.04` (`confirmed`);
- misconception persistente adiciona `-0.03` ou `-0.06`, respectivamente;
- resolver uma misconception não cria bônus sem evidência positiva;
- enquanto existir misconception ativa, ganho positivo fica limitado a `+0.02` por avaliação;
- o resultado é arredondado para três casas e limitado a `0..1`.

Os thresholds não substituem o score:

```text
mastery < 0.50   -> insufficient
0.50..0.79       -> partial
mastery >= 0.80  -> operational
```

## Confidence

`ConceptState.evidence_summary` registra avaliações positivas/negativas e sequências consecutivas.

- `low -> medium`: duas avaliações positivas consecutivas;
- `medium -> high`: quatro positivas totais, três consecutivas, mastery `>=0.80` e nenhuma misconception ativa;
- evidência negativa forte, misconception confirmada ou duas negativas consecutivas reduzem no máximo um nível por avaliação;
- uma única resposta, mesmo forte, nunca eleva diretamente para `high`.

## Misconceptions e auditabilidade

Misconceptions são mescladas por ID. Descrição/status mais recentes substituem os anteriores, IDs de evidência são unidos e registros resolvidos permanecem no histórico. Apenas conceitos citados por mastery evidence, erro conceitual ou misconception são atualizados.

Cada `MasteryChange` possui IDs determinísticos derivados da avaliação/conceito e registra `attempt_id`, `evaluation_id`, evidence IDs, versão, timestamp e justificativa quantitativa. Conceitos inexistentes causam `UnknownConceptError` antes de qualquer atualização.
