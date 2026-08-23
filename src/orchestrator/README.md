# Application coordinator — B18/B19

Coordena o primeiro ciclo end-to-end sem copiar regras dos serviços de domínio. `TutorApplication` mantém a sessão, entrega evidências de B16 ao B17, encaminha `Evaluation` ao B08, solicita a decisão B10 e pede à State Machine B14 que valide a transição.

As responsabilidades permanecem separadas:

- B13 conduz o PROBE e cria o `LearnerState` inicial;
- B15 gera e valida o exercício e mantém o metadata trusted fora da apresentação;
- B16 é o único caminho de execução/validação SQL;
- B17 interpreta evidências, B08 atualiza domínio, B10 decide e B14 aceita ou rejeita a transição;
- `TutorPhaseService` usa B11/B12 somente para compor PLAN e TEACH;
- B19 recebe snapshots por uma interface `SessionStore`; a implementação PostgreSQL grava
  o ciclo completo em uma transação e a implementação em memória atende testes.

`ApplicationResult` expõe somente um resumo público da sessão e eventos próprios para apresentação. A sessão interna contém o metadata necessário a B16, mas nunca é renderizada pelo terminal. A recuperação valida novamente os contratos B07/B13/B14/B15/B17; um snapshot inválido falha explicitamente, sem criar uma sessão nova. O coordenador não contém SQL de persistência, não cria API HTTP e não implementa logging estruturado.
