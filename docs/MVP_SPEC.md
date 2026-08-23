# MVP Specification v0.1

## 1. Objetivo

Validar a hipótese de produto:

> Uma LLM consegue ensinar SQL de forma adaptativa usando execução real no PostgreSQL como evidência objetiva de aprendizagem.

O MVP não procura entregar uma plataforma completa. Deve provar o núcleo pedagógico e técnico.

## 2. Persona inicial

Um aluno que deseja aprender ou aperfeiçoar SQL e aceita interagir inicialmente por terminal.

## 3. Jornada principal

1. Aluno inicia uma sessão.
2. Informa `Quero aprender SQL` ou um subtema.
3. Tutor executa `PROBE` antes de ensinar.
4. Tutor cria/atualiza Learner Model por conceito.
5. Tutor apresenta plano resumido.
6. Tutor ensina ou propõe prática conforme o nível detectado.
7. Quando houver exercício SQL, aluno submete uma query.
8. Executor valida e executa a query no PostgreSQL sandbox.
9. Sistema coleta evidências objetivas.
10. Tutor avalia a tentativa usando evidências + objetivo pedagógico.
11. Aplicação atualiza o Learner Model segundo política controlada.
12. Tutor escolhe `retry`, `reteach`, `practice`, `advance` ou `review`.
13. O ciclo continua até haver evidência suficiente para Apply e Transfer Test.

## 4. Requisitos funcionais

### RF-01 — Sessão

O sistema deve manter uma sessão de aprendizagem com identificador, assunto, estado atual e histórico mínimo necessário.

### RF-02 — Diagnóstico adaptativo

Antes de iniciar o ensino, o tutor deve aplicar aproximadamente 5–12 questões, adaptando dificuldade e investigando pré-requisitos quando necessário.

Durante o diagnóstico, não deve ensinar as respostas.

### RF-03 — Learner Model

O sistema deve representar conhecimento por conceito com no mínimo:

```text
concept
mastery: 0.00..1.00
confidence: low | medium | high
misconception: string | null
```

Interpretação inicial:

```text
mastery >= 0.80  domínio operacional
0.50..0.79       domínio parcial
< 0.50           insuficiente
```

Uma resposta correta isolada não estabelece domínio.

### RF-04 — Knowledge Dependency Graph

O tutor deve raciocinar sobre dependências entre conceitos e evitar tratar SQL apenas como uma sequência rígida de capítulos.

O MVP pode manter o grafo em configuração estática inicial, desde que o tutor use dependências para diagnóstico e adaptação.

### RF-05 — Exercício

Cada exercício deve possuir, no mínimo:

```text
id
concepts
level/difficulty
statement
expected_skills
validation_strategy
```

A solução de referência não deve ser enviada ao aluno antes da política de autocorreção permitir.

### RF-06 — Submissão SQL

O aluno deve poder submeter uma SQL associada ao exercício atual.

A submissão deve ser armazenada como tentativa imutável.

### RF-07 — Execução real

A SQL deve ser executada em PostgreSQL controlado. A LLM nunca deve simular o resultado como substituto dessa execução.

### RF-08 — Evidências de execução

O executor deve retornar, conforme aplicável:

```text
status
rows/resultado limitado
column metadata
execution error
row count
timing
EXPLAIN ou EXPLAIN ANALYZE quando solicitado e seguro
```

### RF-09 — Avaliação

A avaliação deve combinar:

- correção do resultado;
- erro de execução;
- objetivo do exercício;
- estrutura/abordagem da query quando relevante;
- plano de execução quando o objetivo envolver performance;
- evidências históricas de domínio.

### RF-10 — Feedback socrático

Quando a resposta estiver errada, usar preferencialmente:

```text
ERRO -> PERGUNTA SOCRÁTICA -> AUTOCORREÇÃO -> PISTA -> NOVA TENTATIVA -> EXPLICAÇÃO
```

A resposta completa pode ser mostrada quando novas tentativas deixarem de gerar aprendizado.

### RF-11 — Adaptação

Após avaliações relevantes:

```text
mastery >= .80 -> candidato a avanço
.50-.79        -> prática adicional
< .50          -> reensino/investigação de pré-requisito
```

O avanço deve considerar confidence e qualidade das evidências, não apenas o número de mastery.

### RF-12 — Review

O tutor deve periodicamente misturar conceitos atuais e anteriores para testar retenção.

### RF-13 — Apply

Ao obter domínio operacional nos conceitos essenciais, o tutor deve gerar um problema realista que combine múltiplos conceitos e exija análise, proposta, justificativa e implementação.

### RF-14 — Transfer Test

Após Apply, o tutor deve apresentar problema diferente que exija os mesmos princípios para verificar generalização.

### RF-15 — Persistência

Ao reiniciar o processo, o estado persistido deve permitir recuperar ao menos Learner Model, exercício atual e histórico de tentativas relevante.

## 5. Requisitos não funcionais

### RNF-01 — Segurança

Queries de aluno são entrada não confiável. A segurança não pode depender apenas da LLM nem apenas de regex.

### RNF-02 — Isolamento

O usuário do PostgreSQL usado pelo executor não deve poder acessar tabelas de estado interno da aplicação.

### RNF-03 — Limites

Toda execução deve possuir timeout e limite de resultado.

### RNF-04 — Auditabilidade

Deve ser possível relacionar uma mudança de mastery às tentativas/evidências que a motivaram.

### RNF-05 — Testabilidade

Regras determinísticas devem possuir testes sem necessidade de chamadas reais à LLM.

### RNF-06 — Observabilidade mínima

Registrar de forma estruturada: session id, exercise id, attempt id, execução, decisão pedagógica e erro técnico, sem registrar segredos.

## 6. Dataset educacional inicial

Um único dataset relacional é suficiente. Sugestão conceitual:

```text
customers
orders
order_items
products
categories
employees
departments
```

Deve permitir exercitar progressivamente:

```text
SELECT / WHERE / ORDER BY
NULL / CASE
aggregations / GROUP BY / HAVING
JOINs
subqueries
CTEs
window functions
date/time
query reasoning
indexes / EXPLAIN / optimization
```

O dataset final pode ser ajustado na implementação, mas deve possuir dados suficientes para casos não triviais e edge cases.

## 7. Sandbox v0.1

Inicialmente, exercícios executados pelo aluno são read-only.

Controles mínimos:

- usuário PostgreSQL read-only;
- schema allowlist;
- `statement_timeout`;
- limite de linhas retornadas;
- single statement;
- bloqueio de comandos/capacidades incompatíveis com read-only;
- conexão separada do armazenamento do Learner Model;
- encerramento/rollback seguro da execução.

## 8. Critérios de aceite do MVP

### CA-01

Dado um aluno novo, quando solicita aprender SQL, o tutor inicia diagnóstico antes de ensinar.

### CA-02

Após o diagnóstico, existe um Learner Model estruturado com múltiplos conceitos e confidence coerente com as evidências.

### CA-03

O tutor consegue propor um exercício compatível com o estado do aluno.

### CA-04

Uma query válida submetida é realmente executada no PostgreSQL e o resultado retorna ao fluxo de avaliação.

### CA-05

Uma query inválida produz erro real do PostgreSQL e o tutor diferencia erro técnico de lacuna conceitual quando possível.

### CA-06

Uma query que tenta ação proibida é recusada pelo sandbox antes de causar alteração indevida.

### CA-07

Após tentativa avaliada, o Learner Model é atualizado com rastreabilidade para a evidência utilizada.

### CA-08

O tutor escolhe uma próxima ação diferente conforme evidência de domínio: retry/reteach/practice/advance/review.

### CA-09

O processo completo funciona no terminal sem frontend.

### CA-10

Testes automatizados cobrem pelo menos regras do sandbox, atualização do Learner Model e principais transições do fluxo.

## 9. Não objetivos do MVP

Não implementar nesta fase:

- aplicação web;
- autenticação;
- múltiplos alunos concorrentes como requisito de produto;
- gamificação;
- pagamentos;
- marketplace de cursos;
- outros SGBDs;
- execução irrestrita de DDL/DML;
- arquitetura distribuída;
- Kubernetes;
- infraestrutura cloud de produção.

## 10. Métrica de sucesso técnico

O MVP é tecnicamente validado quando o fluxo completo de diagnóstico, exercício, execução real, avaliação, atualização de estado e adaptação funciona de forma reproduzível e testável.

## 11. Métrica de sucesso pedagógico inicial

Em sessões de teste manual, o sistema deve demonstrar que consegue:

- não ensinar abaixo do nível detectado;
- detectar pelo menos algumas misconceptions deliberadamente introduzidas;
- insistir/reensinar após erros recorrentes;
- avançar após evidências múltiplas de domínio;
- recuperar conceito anterior em Review;
- testar generalização em Transfer Test.
