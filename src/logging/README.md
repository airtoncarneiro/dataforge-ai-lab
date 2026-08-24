# Structured logging — B20

Eventos são JSON com `timestamp` UTC, `level`, `event_name`, `schema_version`,
`policy_version`, correlação e resultado operacional. `ConsoleJsonLogger` é o
sink padrão da aplicação; `NullLogger` e `InMemoryLogger` atendem testes e
integrações.

O catálogo inclui lifecycle/recovery de sessão, PROBE, transição de fase,
exercício, tentativa, validação, avaliação, atualização de LearnerState,
decisão adaptativa, persistência e chamada LLM. Os IDs de sessão, exercício,
tentativa, avaliação e request da LLM aparecem apenas quando aplicáveis.

`redact()` é a única fronteira de sanitização: remove segredos, URLs de conexão,
SQL bruto, referência e metadata trusted. SQL pode ser correlacionada por
`sql_fingerprint`, sem armazenar seu texto. Falha do sink é ignorada para não
alterar o fluxo do tutor.
