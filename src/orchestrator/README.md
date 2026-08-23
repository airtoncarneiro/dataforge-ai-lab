# Application coordinator — B18

Coordena o primeiro ciclo end-to-end em memória sem copiar regras dos serviços de domínio. `TutorApplication` mantém a sessão, entrega evidências de B16 ao B17, encaminha `Evaluation` ao B08, solicita a decisão B10 e pede à State Machine B14 que valide a transição.

As responsabilidades permanecem separadas:

- B13 conduz o PROBE e cria o `LearnerState` inicial;
- B15 gera e valida o exercício e mantém o metadata trusted fora da apresentação;
- B16 é o único caminho de execução/validação SQL;
- B17 interpreta evidências, B08 atualiza domínio, B10 decide e B14 aceita ou rejeita a transição;
- `TutorPhaseService` usa B11/B12 somente para compor PLAN e TEACH.

`ApplicationResult` expõe somente um resumo público da sessão e eventos próprios para apresentação. A sessão interna contém o metadata necessário a B16, mas nunca é renderizada pelo terminal. B18 não persiste estado, não cria API HTTP e não implementa logging estruturado.
