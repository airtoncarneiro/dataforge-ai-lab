# SQL Mentor AI

Tutor adaptativo de SQL com avaliação baseada em execução real no PostgreSQL.

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