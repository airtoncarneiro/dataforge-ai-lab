# SQL Mentor AI

Tutor adaptativo de SQL com avaliação baseada em execução real no PostgreSQL.

## Estado atual

A fundação `B01-B03`, o SQL Sandbox `B04`, Execution Evidence `B05`, `EXPLAIN` seguro `B06`, os contratos pedagógicos `B07`, o Learner Model Service determinístico `B08`, o Knowledge Dependency Graph `B09`, o Adaptive Decision Service `B10` e o LLM Adapter `B11` estão implementados. A integração da Tutor Policy `B12` e o fluxo pedagógico posterior ainda não fazem parte desta entrega.

## Execução local no macOS / VS Code

Pré-requisitos:

- Node.js 20 ou superior;
- Docker Desktop ou Colima, com Docker Compose;
- terminal integrado do VS Code aberto na raiz do repositório.

Instale as dependências e prepare as variáveis locais. O arquivo `.env` é ignorado pelo Git e não deve conter credenciais de produção:

```bash
npm install
cp .env.example .env
```

Troque as duas senhas de exemplo em `.env`. Depois valide e suba o PostgreSQL:

```bash
npm run db:config
npm run db:up
```

Se usar Colima, inicie-o antes com `colima start`.

Na primeira inicialização, os scripts em `docker/postgres/init/` criam automaticamente:

- o schema `education` e seu dataset;
- o schema privado `app_state`;
- a role `mentor_sandbox`, com `SELECT` somente em `education`;
- timeout padrão e transações read-only para a role de sandbox.

Inicie o scaffold da aplicação de terminal:

```bash
npm start
```

Execute os testes:

```bash
npm test
npm run test:integration
```

Os testes de integração pressupõem o PostgreSQL saudável após `npm run db:up`. Para reaplicar os scripts de inicialização em um volume vazio, use conscientemente `npm run db:reset`; esse comando remove somente o volume local deste Compose.

O sandbox usa `SQL_MENTOR_SANDBOX_TIMEOUT_MS` e `SQL_MENTOR_SANDBOX_MAX_ROWS` para limitar cada consulta. A role da aplicação é fixa como `mentor_sandbox`; não configure o executor com a credencial administrativa.

O LLM Adapter B11 permanece desacoplado do fluxo de terminal até B12 e tarefas posteriores. Para usá-lo programaticamente, configure `OPENAI_API_KEY`, `OPENAI_MODEL`, `LLM_POLICY_VERSION` e os limites `LLM_*` documentados em `.env.example`. Os testes usam exclusivamente o provider fake ou transporte HTTP simulado e não fazem chamadas reais.

Ao terminar:

```bash
npm run db:down
```

## Dataset educacional

O schema `education` contém `customers`, `orders`, `order_items`, `products`, `categories`, `employees` e `departments`. Os dados cobrem `NULL`, cliente sem pedido, produtos sem venda, cliente com múltiplos pedidos, datas variadas e relações com cardinalidades não triviais.

## Objetivo do MVP

Validar se uma LLM consegue conduzir o aprendizado de SQL de forma adaptativa usando evidências objetivas produzidas por um PostgreSQL real.

O MVP deve suportar o ciclo:

```text
PROBE -> PLAN -> TEACH -> PRACTICE -> EVALUATE -> ADAPT -> REVIEW -> APPLY -> TRANSFER TEST
```

Durante exercícios práticos:

```text
Tutor propõe exercício
        ↓
Aluno submete SQL
        ↓
Executor PostgreSQL executa em sandbox
        ↓
Resultado / erro / plano viram evidências
        ↓
LLM avalia pedagogicamente
        ↓
Learner Model é atualizado
        ↓
retry / reteach / practice / advance / review
```

## Escopo inicial

- Interface de terminal; frontend fica fora do MVP inicial.
- Um único aluno/sessão por execução é suficiente inicialmente.
- PostgreSQL como mecanismo real de execução dos exercícios.
- Tutor adaptativo orientado por Knowledge Dependency Graph.
- Diagnóstico inicial antes de ensinar.
- Exercícios gerados/adaptados pelo tutor.
- Avaliação baseada em execução + estrutura da solução + evidências pedagógicas.
- Learner Model persistente.
- SQL sandbox restrito e isolado.

## Fora do escopo inicial

- Frontend web.
- Autenticação e autorização multiusuário.
- Gamificação.
- Billing.
- Multi-tenant.
- Suporte a outros bancos SQL.
- Cursos diferentes de SQL.
- Infraestrutura de produção.

## Documentação

- [`AGENTS.md`](AGENTS.md): regras para Codex e outros agentes de desenvolvimento.
- [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md): requisitos funcionais e critérios de aceite.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): arquitetura lógica e responsabilidades.
- [`docs/LLM_CONTRACT.md`](docs/LLM_CONTRACT.md): contrato entre tutor, LLM e executor.
- [`docs/TUTOR_POLICY.md`](docs/TUTOR_POLICY.md): política pedagógica adaptada ao projeto.
- [`docs/BACKLOG.md`](docs/BACKLOG.md): sequência recomendada de implementação.

## Princípio arquitetural

> A LLM decide pedagogicamente; componentes determinísticos decidem operacionalmente.

A LLM não deve possuir acesso direto ao banco, credenciais ou sistema operacional. Toda execução de SQL passa por uma camada controlada de sandbox/executor.

## Primeiro milestone

Antes de qualquer UI, deve ser possível executar um fluxo completo pelo terminal:

```text
Quero aprender SQL
        ↓
Diagnóstico adaptativo
        ↓
Learner Model inicial
        ↓
Ensino / exercício
        ↓
SQL submetida pelo aluno
        ↓
Execução real em PostgreSQL
        ↓
Avaliação estruturada
        ↓
Atualização do Learner Model
        ↓
Próxima ação adaptativa
```

Consulte `AGENTS.md` antes de implementar qualquer código.
