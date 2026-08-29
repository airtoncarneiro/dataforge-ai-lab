# B24 — Transfer Test

Após uma avaliação objetiva correta de `APPLY`, o orquestrador gera um exercício
em novo contexto e abre `TRANSFER_TEST`. O exercício reutiliza os conceitos
avaliados no Apply, mas pede uma situação de negócio diferente. A submissão usa
o mesmo sandbox, avaliador e Learner Model; nenhuma conclusão é automática.

`TRANSFER_TEST` não é o encerramento da sessão. A conclusão permanece guardada
pela state machine e exige as evidências posteriores previstas no fluxo.
