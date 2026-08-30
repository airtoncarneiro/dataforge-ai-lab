# DataForge AI Lab

Tutor adaptativo para estudantes de dados. O projeto nasceu para testar uma ideia simples: uma LLM pode ensinar conceitos técnicos de forma personalizada quando o progresso do aluno é medido por evidências reais, e não apenas por uma resposta textual gerada pelo modelo?

Hoje, o foco é SQL executado em PostgreSQL. A arquitetura foi pensada para evoluir para outras tecnologias e stacks de engenharia de dados (Spark, Airflow, Python, etc).

## Como funciona

O DataForge AI Lab combina uma aplicação que controla a sessão, uma LLM que orienta a conversa e um PostgreSQL controlado que executa e valida as consultas do aluno.

A LLM não recebe acesso direto ao banco nem decide sozinha o resultado de uma consulta. O SQL passa por um sandbox com permissões mínimas, limite de tempo, limite de linhas e validações de segurança.

## Fluxo de aprendizagem

O tutor segue este modelo de prompt e de progressão:

```text
PROBE -> PLAN -> TEACH -> PRACTICE -> EVALUATE -> ADAPT
   -> REVIEW -> APPLY -> TRANSFER TEST
```

- **PROBE**: diagnostica o conhecimento atual sem ensinar a resposta.
- **PLAN**: organiza os conceitos e pré-requisitos que serão trabalhados.
- **TEACH**: apresenta explicações curtas, exemplos e modelos mentais.
- **PRACTICE**: propõe um exercício para o aluno resolver.
- **EVALUATE**: executa o SQL e reúne resultado, erros e metadados objetivos.
- **ADAPT**: atualiza o modelo do aluno e escolhe a próxima ação.
- **REVIEW**: revisa conceitos anteriores para verificar retenção.
- **APPLY**: propõe um problema integrado e próximo de um caso real.
- **TRANSFER TEST**: apresenta um novo contexto para verificar a aplicação dos mesmos princípios.

O ciclo pode repetir `retry`, `reteach`, `practice` ou `review` antes de avançar. Uma resposta correta isolada não é suficiente para declarar domínio.

## Pré-requisitos

- Git;
- Node.js 20 ou superior;
- Docker Desktop ou Colima com Docker Compose;
- OmniRoute local ou outro endpoint de API compatível com OpenAI.

## Instalação rápida

```bash
git clone https://github.com/airtoncarneiro/dataforge-ai-lab.git
cd dataforge-ai-lab
npm install
cp .env.example .env
```

Abra `.env` e altere as duas senhas locais:

```dotenv
SQL_MENTOR_POSTGRES_PASSWORD=uma-senha-local
SQL_MENTOR_SANDBOX_PASSWORD=outra-senha-local
```

Se usar Colima, inicie o Docker antes:

```bash
colima start
```

Suba o PostgreSQL:

```bash
npm run db:up
```

Na primeira execução, o Docker cria automaticamente o banco educacional, as tabelas de estado da aplicação e a role restrita usada pelo sandbox.

## Configuração da LLM

O OmniRoute é o provider preferido porque oferece um endpoint local compatível com a API da OpenAI e oferece modelos gratuitos.

No `.env`, configure:

```dotenv
LLM_PROVIDER=omniroute
OMNIROUTE_API_KEY=sua-chave-criada-no-omniroute
OMNIROUTE_BASE_URL=http://localhost:20128/v1
OPENAI_MODEL=antigravity/gemini-3.6-flash-high
```

Ou usar, ainda, o modelo `auto/coding`

Qualquer API que implemente o contrato OpenAI-compatible é válida como alternativa. Ela precisa oferecer chat completions e saída estruturada JSON. Quando o endpoint tiver outro endereço, informe sua URL base em `OMNIROUTE_BASE_URL`; se necessário, adapte o provider/configuração local para o nome e a autenticação usados por ele.

## Iniciar a aplicação

Com o PostgreSQL e a LLM configurados:

```bash
npm run web
```

Abra <http://127.0.0.1:3000>. A interface é experimental, não possui autenticação e aceita conexões somente da própria máquina.

Informe o objetivo de aprendizagem no campo apresentado, digite o que você quer aprender de SQL. Exemplos:

```text
Quero aprender SQL

ou

Quero aprender a usar joins e subconsultas

ou

Quero aprender a usar funções agregadas e filtros
```

## Modo demo

Para experimentar o fluxo sem chamadas reais à LLM:

```bash
npm run demo
```

O PostgreSQL continua sendo necessário, pois as consultas do aluno são executadas no sandbox real.

## Retomar uma sessão

O ID da sessão aparece ao iniciar o tutor. Assim, é possível continuar de onde parou.

O progresso, o exercício atual, as tentativas e as avaliações ficam separados no schema privado `app_state`.

## Testes e encerramento

```bash
npm test
npm run test:integration
npm run db:down
```

Para apagar também o volume local e começar com dados limpos, use `npm run db:reset`. Esse comando remove somente os dados locais deste projeto.

## Dataset educacional

O banco contém `customers`, `orders`, `order_items`, `products`, `categories`, `employees` e `departments`, com dados para praticar projeção, filtros, agregações, relacionamentos, subconsultas e análise de planos.

## Princípio do projeto

> A LLM orienta pedagogicamente; componentes determinísticos executam, validam e persistem os fatos.

Para detalhes, consulte [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/LLM_CONTRACT.md`](docs/LLM_CONTRACT.md), [`docs/TUTOR_POLICY.md`](docs/TUTOR_POLICY.md) e [`docs/BACKLOG.md`](docs/BACKLOG.md).
