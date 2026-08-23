# Architecture v0.1

## Objetivo

Separar claramente decisões pedagógicas probabilísticas de controles operacionais determinísticos.

## Visão lógica

```text
┌────────────────────────────────────────────┐
│                Terminal UI                 │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────┐
│              Tutor Orchestrator            │
│                                            │
│  session state / transitions / context     │
└──────────────┬───────────────┬─────────────┘
               │               │
               ▼               ▼
      ┌────────────────┐  ┌──────────────────┐
      │   LLM Adapter  │  │ Learner Model    │
      │                │  │ Service          │
      └───────┬────────┘  └────────┬─────────┘
              │                    │
              │                    ▼
              │              State Storage
              │
              ▼
      Structured decisions
              │
              ▼
┌────────────────────────────────────────────┐
│            Exercise / Evaluator            │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────┐
│              SQL Sandbox API               │
│ validation / limits / execution / explain │
└─────────────────────┬──────────────────────┘
                      │
                      ▼
                PostgreSQL
             educational data
```

## Componentes

### 1. Terminal UI

Responsabilidade:

- receber mensagens e SQL;
- exibir perguntas, feedback e resultados;
- não conter regra pedagógica relevante;
- não conectar diretamente no PostgreSQL.

### 2. Tutor Orchestrator

Responsabilidade:

- controlar fase atual: PROBE, PLAN, TEACH, PRACTICE, EVALUATE, ADAPT, REVIEW, APPLY, TRANSFER TEST;
- montar contexto necessário para a LLM;
- chamar executor quando houver submissão SQL;
- persistir eventos/estado;
- aplicar transições válidas.

O Orchestrator é a autoridade do workflow. A LLM recomenda a próxima ação dentro do contrato; a aplicação valida a transição.

### 3. LLM Adapter

Responsabilidade:

- encapsular provedor/modelo;
- enviar política + contexto;
- solicitar saída estruturada;
- executar tool calling somente através de ferramentas registradas;
- tratar timeout/erro/retry do provedor;
- impedir vazamento de segredos no prompt.

A troca de provedor/modelo não deve exigir alterar regras centrais do domínio.

### 4. Learner Model Service

Responsabilidade:

- ler estado por conceito;
- receber evidências estruturadas;
- atualizar mastery/confidence segundo política explícita;
- registrar misconceptions;
- manter rastreabilidade da atualização.

A LLM não grava diretamente o valor final de mastery.

### 5. Exercise Service

Responsabilidade:

- representar exercício atual;
- armazenar conceitos-alvo e difficulty;
- manter validation strategy;
- guardar solução de referência apenas quando necessário e nunca expô-la automaticamente;
- associar tentativas ao exercício.

Exercícios podem inicialmente ser gerados pela LLM, curados estaticamente ou híbridos. O contrato deve permitir evolução.

### 6. Evaluator

Responsabilidade:

Combinar evidências determinísticas e julgamento pedagógico.

Exemplos de evidências determinísticas:

- query executou;
- conjunto de colunas;
- conjunto/ordenação de linhas quando relevante;
- erro PostgreSQL;
- row count;
- plano de execução.

Exemplos de julgamento pedagógico:

- misconception provável;
- qualidade da explicação;
- necessidade de pista;
- conceito pré-requisito a revisar;
- próxima ação sugerida.

### 7. SQL Sandbox

Responsabilidade:

- tratar SQL do aluno como entrada hostil;
- validar política read-only;
- executar com credenciais mínimas;
- aplicar timeout e limite;
- fornecer resultado estruturado;
- opcionalmente obter `EXPLAIN` controlado.

A segurança deve existir em camadas:

```text
application policy
    +
SQL parser/statement inspection quando aplicável
    +
PostgreSQL transaction/read-only mode
    +
least-privilege database role
    +
timeout/resource limits
    +
schema isolation
```

### 8. PostgreSQL Educacional

Contém somente objetos necessários aos exercícios.

Não deve expor:

- secrets;
- credenciais;
- estado interno do tutor;
- tabelas administrativas da aplicação.

### 9. State Storage

Pode começar simples, inclusive no próprio PostgreSQL, desde que seja logicamente/permissionamente isolado do usuário de sandbox.

Entidades mínimas conceituais:

```text
learning_session
concept_state
exercise
attempt
execution_evidence
assessment
mastery_change
```

## Fluxo de uma tentativa SQL

```text
Aluno submete SQL
    ↓
Orchestrator valida estado da sessão
    ↓
Sandbox valida política
    ↓
PostgreSQL executa
    ↓
ExecutionEvidence
    ↓
Evaluator prepara contexto
    ↓
LLM retorna Assessment estruturado
    ↓
Learner Model Service calcula mudança
    ↓
Persistência
    ↓
Orchestrator escolhe próxima transição
    ↓
Tutor responde ao aluno
```

## Princípio de validação do resultado

Não exigir equivalência textual com uma query de referência.

Uma solução pode ser semanticamente correta com estrutura diferente. A estratégia de validação deve depender do exercício, por exemplo:

```text
RESULT_SET          compara resultado normalizado
ORDERED_RESULT      compara resultado preservando ordem
PROPERTY_BASED      verifica propriedades/invariantes
PLAN_CONSTRAINT     verifica aspecto do plano
MANUAL_LLM_REVIEW   julgamento complementar, nunca substitui execução
```

## Fronteiras de confiança

### Não confiável

- entrada do aluno;
- SQL submetida;
- texto livre gerado pela LLM;
- argumentos solicitados por tool calling.

### Confiável somente após validação

- decisão estruturada da LLM;
- pedido de execução de tool;
- mudança sugerida de domínio.

### Evidência objetiva

- resposta real do PostgreSQL;
- metadados gerados pelo executor;
- regras determinísticas da aplicação.

## Contexto enviado à LLM

Usar contexto mínimo suficiente:

```text
Tutor Policy
Current Phase
Learning Goal
Relevant Knowledge Graph slice
Relevant Learner Model slice
Current Exercise
Attempt
Execution Evidence
Recent necessary dialogue
```

Não enviar histórico completo indefinidamente.

## Estratégia de evolução

### v0.1

Terminal + PostgreSQL sandbox + LLM + Learner Model.

### Pós-MVP

- frontend web;
- editor SQL dedicado;
- autenticação;
- múltiplos usuários;
- datasets adicionais;
- DML/DDL em ambientes descartáveis;
- métricas pedagógicas agregadas;
- avaliações offline de prompts/modelos.

Essas evoluções não devem ser antecipadas no código do primeiro milestone sem necessidade concreta.