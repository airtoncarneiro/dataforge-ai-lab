# SQL Mentor AI

Tutor adaptativo de SQL com avaliação baseada em execução real no PostgreSQL.

## Estado atual

A fundação `B01-B03`, o SQL Sandbox `B04`, Execution Evidence `B05`, `EXPLAIN` seguro `B06`, os contratos pedagógicos `B07`, o Learner Model Service determinístico `B08`, o Knowledge Dependency Graph `B09`, o Adaptive Decision Service `B10`, o LLM Adapter `B11`, a Tutor Policy `B12`, o diagnóstico PROBE `B13`, a State Machine `B14`, a geração/seleção de exercícios `B15`, o Result Validator `B16`, o Evaluator pedagógico `B17`, o loop de terminal `B18`, a persistência/recovery `B19`, logs estruturados `B20` e os incrementos P1 `B21-B26` estão implementados.

O adaptador usa diretamente a API Google Gemini `generateContent`. O modelo
free configurado é `gemma-4-26b-a4b-it`; a resposta JSON é solicitada pela API e
validada localmente contra o schema antes de entrar no fluxo pedagógico.

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

Em uma instalação cujo volume PostgreSQL já existia antes de B19, aplique a
migração idempotente uma vez antes de iniciar o tutor:

```bash
npm run db:migrate
```

Se usar Colima, inicie-o antes com `colima start`.

Na primeira inicialização, os scripts em `docker/postgres/init/` criam automaticamente:

- o schema `education` e seu dataset;
- o schema privado `app_state`;
- a role `mentor_sandbox`, com `SELECT` somente em `education`;
- timeout padrão e transações read-only para a role de sandbox.

O estado de aprendizagem é gravado em tabelas `app_state.tutor_*`, separadas do
dataset `education`. A role `mentor_sandbox` não possui privilégios nesse
schema. Para retomar uma sessão previamente encerrada ou interrompida, use o ID
mostrado no início da sessão:

```bash
npm start -- --resume <sessionId>
```

Inicie o fluxo completo com o provider configurado em `.env`:

```bash
npm start
```

Para executar o mesmo fluxo sem chamadas reais à LLM, use o provider demo determinístico. O PostgreSQL continua obrigatório porque a SQL do aluno é executada pelo Sandbox real:

```bash
npm run demo
```

No terminal, responda às perguntas do PROBE e finalize SQL multilinha escrevendo `.enviar` em uma linha separada. Use `sair` para encerrar.

Execute os testes:

```bash
npm test
npm run test:integration
```

Para validar os cenários pedagógicos B25 sem chamadas externas:

```bash
npm run test:eval-fixtures
```

Uma avaliação ao vivo opcional usa as variáveis do `.env` e pode consumir quota
do provider. Configure `LLM_EVAL_DELAY_MS` para espaçar as chamadas; o gate usa
`LLM_EVAL_MAX_OUTPUT_TOKENS=320` por padrão para manter respostas compactas:

```bash
set -a; source .env; set +a; npm run eval:live
```

O shell web local pode ser iniciado com `npm run web` e fica disponível em
`http://127.0.0.1:3000`.

A interface web local permite iniciar uma sessão, responder ao PROBE, acompanhar
o plano/ensino, testar uma SQL em prévia e submetê-la para avaliação. Ela não
possui autenticação e escuta somente em `127.0.0.1`.

Os testes de integração pressupõem o PostgreSQL saudável após `npm run db:up`. Para reaplicar os scripts de inicialização em um volume vazio, use conscientemente `npm run db:reset`; esse comando remove somente o volume local deste Compose.

O sandbox usa `SQL_MENTOR_SANDBOX_TIMEOUT_MS` e `SQL_MENTOR_SANDBOX_MAX_ROWS` para limitar cada consulta. A role da aplicação é fixa como `mentor_sandbox`; não configure o executor com a credencial administrativa.

O PROBE B13 integra programaticamente o LLM Adapter B11, a Tutor Policy B12, o Knowledge Graph B09 e o Learner Model Service B08. A State Machine B14 valida a conclusão do PROBE e converte decisões B10 em transições de fase. O Exercise Service B15 usa B11/B12 para geração estruturada, mas aplica localmente difficulty, pré-requisitos e validação de metadata. O Result Validator B16 executa aluno e referência exclusivamente pelo Sandbox, compara resultados sem equivalência textual e verifica constraints pela AST/plano; a `reference_query` trusted nunca entra no contrato público. O Evaluator B17 preserva esses fatos como authoritative, usa B11/B12 somente para interpretação pedagógica e produz `Evaluation` B07 com fallback determinístico. A coordenação B18 encadeia esses componentes, enquanto B08 continua aplicando evidências e B10 continua decidindo a ação final. B19 persiste snapshots e registros normalizados com transação e chaves idempotentes para que uma `Evaluation` e seus `MasteryChange` não sejam reaplicados. B20 emite JSON estruturado para stdout, com IDs correlacionados e redaction central de segredos, SQL e conteúdo trusted. A aplicação usa o OmniRoute local com `LLM_PROVIDER=omniroute`, `OMNIROUTE_BASE_URL=http://localhost:20128/v1`, `OPENAI_MODEL=antigravity/gemini-3.6-flash-high`, `LLM_POLICY_VERSION=tutor-policy-v0.1` e os limites `LLM_*` documentados em `.env.example`. Os testes não fazem chamadas reais ao provider.

O fluxo não depende de preset de roteamento; a aplicação usa diretamente a Gemini API.

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

- Interface de terminal e um shell web local para experimentar o mesmo fluxo.
- Um único aluno/sessão por execução é suficiente inicialmente.
- PostgreSQL como mecanismo real de execução dos exercícios.
- Tutor adaptativo orientado por Knowledge Dependency Graph.
- Diagnóstico inicial antes de ensinar.
- Exercícios gerados/adaptados pelo tutor.
- Avaliação baseada em execução + estrutura da solução + evidências pedagógicas.
- Learner Model persistente.
- SQL sandbox restrito e isolado.

## Fora do escopo inicial

- Frontend web de produção.
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
