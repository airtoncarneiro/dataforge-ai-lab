# Terminal conversation loop — B18

`TerminalConversationLoop` é uma camada de I/O: lê o objetivo, respostas do PROBE e SQL multilinha; chama a aplicação; e renderiza apenas eventos públicos. Uma submissão SQL termina com `.enviar` em linha separada. `sair`, EOF e Ctrl-C encerram a sessão sem stack trace.

O loop não calcula mastery, não escolhe a próxima ação e não acessa PostgreSQL diretamente. `NodeTerminalIO` pode ser substituído por I/O roteirizado nos testes.

Execução com provider real configurado:

```bash
npm start
```

Demo determinística sem chamada à LLM, ainda usando o PostgreSQL real:

```bash
npm run demo
```

Com B19 e PostgreSQL configurado, uma sessão persistida pode ser retomada sem
reexecutar tentativas já gravadas:

```bash
npm start -- --resume <sessionId>
```
