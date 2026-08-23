# Persistence/recovery — B19

`SessionStore` separa a persistência da coordenação B18 e dos serviços de
domínio. `InMemorySessionStore` é determinístico para testes; `PostgresSessionStore`
persiste no schema privado `app_state`.

O PostgreSQL guarda um snapshot contratualmente validado e projeções
normalizadas de sessão, LearnerState, PROBE, flow, exercício atual, tentativas,
avaliações, mudanças de mastery e decisão adaptativa. A gravação do ciclo
`Attempt → Evaluation → MasteryChange → AdaptiveDecision → FlowState` ocorre em
uma transação.

IDs estáveis tornam inserts de tentativa, avaliação e mudança de mastery
idempotentes: repetir o mesmo payload não duplica dados; conteúdo divergente
gera `IdempotencyConflictError`. O carregamento compara snapshot e projeções e
revalida os contratos existentes; corrupção ou ausência gera erro explícito.

Para uma base existente, execute `npm run db:migrate`. Em banco criado do zero,
o script `docker/postgres/init/020_b19_persistence.sql` é aplicado pelo
PostgreSQL. A role `mentor_sandbox` não recebe nenhum privilégio em `app_state`.
