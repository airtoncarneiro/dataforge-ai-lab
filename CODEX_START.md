# Codex Kickoff

Use este arquivo como ponto de partida para a primeira sessão de implementação.

## Contexto obrigatório

Antes de codificar, leia integralmente:

- `AGENTS.md`
- `docs/MVP_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/LLM_CONTRACT.md`
- `docs/TUTOR_POLICY.md`
- `docs/BACKLOG.md`

## Primeira missão

Implemente somente o primeiro slice vertical necessário para avançar até o milestone de terminal, começando por `B01`, `B02` e `B03`.

Objetivo da primeira entrega:

1. scaffold mínimo do projeto;
2. PostgreSQL local reproduzível;
3. dataset educacional carregável;
4. role de sandbox read-only separada;
5. testes básicos da inicialização e isolamento;
6. documentação de execução local no macOS/VS Code.

Ainda não implemente frontend.

Ainda não implemente abstrações complexas de agentes.

Não implemente funcionalidades pós-MVP.

## Forma de trabalho esperada

- Analise o repositório e proponha alterações concretas.
- Implemente diretamente quando os requisitos estiverem claros.
- Se houver decisão tecnológica que não esteja definida e que seja difícil de reverter, exponha a decisão antes de acoplá-la profundamente.
- Prefira soluções simples e testáveis.
- Faça commits coerentes por incremento quando autorizado pelo ambiente.
- Rode os testes aplicáveis antes de considerar a tarefa concluída.
- Atualize o backlog/documentação apenas quando a implementação mudar uma decisão relevante.

## Próxima missão após a fundação

Seguir `B04` -> `B05` -> `B06`, entregando o SQL Sandbox antes da integração real com a LLM.

A ordem é deliberada: primeiro produzir evidências confiáveis do PostgreSQL; depois integrar o tutor que as interpretará.

## Primeiro gate técnico

Antes de integrar a LLM, deve existir teste automatizado demonstrando que:

```text
SELECT permitido -> executa
DDL -> bloqueado
DML -> bloqueado
múltiplos statements -> bloqueados
query longa -> timeout
resultado grande -> truncado/limitado
role sandbox -> não altera dataset
```

Somente após esse gate iniciar `B07` em diante.
