# MVP Backlog

Execute em ordem. Não iniciar frontend antes de concluir o milestone end-to-end de terminal.

## P0 — Fundação

### B01 — Scaffold do projeto

Objetivo: criar estrutura mínima executável, configuração local e testes.

Critérios de aceite:

- comando documentado inicia aplicação de terminal;
- configuração por environment variables;
- secrets fora do Git;
- testes podem ser executados localmente;
- estrutura respeita separação Orchestrator / LLM / Sandbox / Learner Model.

### B02 — PostgreSQL local

Objetivo: ambiente PostgreSQL reproduzível para desenvolvimento.

Critérios de aceite:

- inicialização local documentada;
- dataset educacional carregado automaticamente ou por comando único;
- role de sandbox separada e read-only;
- estado da aplicação não acessível pela role de sandbox.

### B03 — Dataset educacional

Objetivo: criar dataset pequeno, consistente e útil para exercícios.

Cobrir ao menos:

- clientes;
- pedidos;
- itens;
- produtos;
- categorias;
- funcionários/departamentos.

Incluir edge cases: NULL, clientes sem pedidos, produtos sem venda, múltiplos pedidos, datas diversas, cardinalidades não triviais.

## P0 — Segurança e execução

### B04 — SQL Sandbox

Objetivo: executar somente SQL read-only permitida.

Critérios de aceite:

- SELECT/CTE de leitura funcionam;
- múltiplos statements são bloqueados;
- DDL é bloqueado;
- INSERT/UPDATE/DELETE/TRUNCATE são bloqueados;
- COPY e operações perigosas são bloqueadas;
- statement timeout funciona;
- quantidade de linhas é limitada;
- role do banco impede alteração mesmo em caso de falha da validação da aplicação.

### B05 — Execution Evidence

Objetivo: normalizar resultado do PostgreSQL.

Retornar:

```text
status
columns
rows limitadas
row_count/truncated
duration_ms
sqlstate/error category
```

Critério: testes não dependem da LLM.

### B06 — EXPLAIN controlado

Objetivo: fornecer plano para exercícios de performance.

Critérios:

- `EXPLAIN (FORMAT JSON)` suportado;
- `ANALYZE` desabilitado por padrão;
- mesmas regras de sandbox aplicadas.

## P0 — Domínio pedagógico

### B07 — Modelos de domínio

Implementar representações para:

```text
LearningSession
ConceptState
Exercise
Attempt
ExecutionEvidence
Assessment
MasteryEvidence
MasteryChange
```

Incluir IDs e timestamps necessários para auditabilidade.

### B08 — Learner Model Service

Objetivo: política determinística/versionada de atualização.

Critérios:

- LLM fornece evidências, não valor final arbitrário;
- múltiplas evidências aumentam confidence;
- uma resposta correta isolada não leva automaticamente a domínio alto;
- falhas podem reduzir mastery/confidence de forma limitada;
- toda mudança referencia evidência/attempt.

### B09 — Knowledge Graph inicial

Objetivo: configuração inicial de conceitos e dependências SQL.

Começar com grafo suficiente para:

```text
SELECT
WHERE
NULL
ORDER BY
aggregations
GROUP BY
HAVING
JOIN semantics
subqueries
CTEs
window functions
indexes/EXPLAIN
```

Critério: serviço consegue retornar pré-requisitos e conceitos dependentes.

## P0 — LLM

### B10 — LLM Adapter

Objetivo: encapsular integração com o provedor escolhido.

Critérios:

- configuração por environment variables;
- prompt/policy version identificável;
- saída estruturada validada;
- erro de formato tratado;
- timeouts/retries técnicos controlados;
- testes usam mock/fake provider.

### B11 — Tutor Policy integration

Objetivo: carregar `docs/TUTOR_POLICY.md` ou derivação versionada como política do tutor.

Critério: não duplicar regras divergentes em vários pontos do código sem necessidade.

### B12 — Diagnóstico PROBE

Objetivo: implementar diagnóstico adaptativo.

Critérios:

- `Quero aprender SQL` começa em PROBE;
- aproximadamente 5–12 questões;
- dificuldade pode subir/descer;
- respostas não são ensinadas durante o diagnóstico;
- ao final, Learner Model inicial é criado.

## P0 — Orquestração

### B13 — State machine do tutor

Objetivo: controlar fases e transições válidas.

Fases:

```text
PROBE
PLAN
TEACH
PRACTICE
EVALUATE
ADAPT
REVIEW
APPLY
TRANSFER_TEST
COMPLETE
```

Critério: LLM não consegue forçar transição inválida.

### B14 — Exercise generation/selection

Objetivo: gerar ou selecionar exercício coerente com Learner Model.

Critérios:

- conceitos-alvo explícitos;
- difficulty explícita;
- validation strategy explícita;
- reference solution nunca exibida automaticamente.

### B15 — Result validator

Objetivo: validar semanticamente respostas quando possível.

Suportar inicialmente:

```text
RESULT_SET
ORDERED_RESULT
PROPERTY_BASED
```

Evitar comparação textual da SQL.

### B16 — Evaluator

Objetivo: combinar resultado determinístico com avaliação pedagógica estruturada.

Critérios:

- distingue erro de execução de erro conceitual;
- registra positive/negative evidence;
- identifica misconception quando houver evidência;
- sugere next_action;
- Learner Model Service decide mudança final.

## P0 — Terminal end-to-end

### B17 — Terminal conversation loop

Objetivo: permitir interação completa sem frontend.

Fluxo de aceite:

```text
start
-> Quero aprender SQL
-> PROBE
-> PLAN
-> TEACH/PRACTICE
-> exercício SQL
-> submissão
-> execução PostgreSQL
-> avaliação
-> atualização de domínio
-> próxima ação
```

### B18 — Persistência/recovery

Objetivo: recuperar sessão interrompida.

Critérios:

- Learner Model persiste;
- exercício/tentativa atual persiste;
- reprocessamento não duplica mastery change.

### B19 — Logs estruturados

Registrar IDs de sessão/exercício/tentativa e decisões sem secrets.

## P1 — Validação pedagógica

### B20 — Socratic retry

Implementar ciclo erro -> pergunta -> pista -> nova tentativa antes de solução completa.

### B21 — Review scheduler

Introduzir revisões cumulativas conforme histórico de conceitos.

### B22 — Apply

Gerar caso integrado após domínio operacional suficiente.

### B23 — Transfer Test

Gerar novo contexto com mesmos princípios e registrar resultado.

## P1 — Robustez

### B24 — Prompt/LLM evaluation fixtures

Criar casos fixos para testar:

- iniciante;
- intermediário;
- aluno que acerta por acaso;
- misconception de NULL;
- misconception de LEFT JOIN + WHERE;
- erro de GROUP BY;
- query correta com abordagem diferente da referência;
- resposta correta mas explicação conceitualmente errada.

### B25 — Sandbox adversarial tests

Cobrir tentativas de bypass, múltiplos statements, comentários, comandos proibidos e queries longas.

## Gate do MVP

Não iniciar frontend até todos os itens P0 necessários ao fluxo B17 estarem funcionando e os critérios CA-01..CA-10 de `MVP_SPEC.md` serem demonstráveis.

## Pós-MVP

Somente após validação:

- frontend web/chat;
- Monaco/editor SQL;
- autenticação;
- multiusuário;
- dashboards/progresso visual;
- datasets adicionais;
- DML/DDL em sandbox descartável;
- eventual migração tecnológica explicitamente decidida pelo owner.
