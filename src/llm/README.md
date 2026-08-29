# LLM Adapter — B11

Fronteira independente de provider para respostas pedagogicas estruturadas. Este componente nao executa SQL, nao acessa o Learner Model e nao decide progressao: a sugestao da LLM continua sujeita ao Adaptive Decision Service B10.

## Interface publica

```js
const result = await adapter.generate({
  instructions,
  messages: [{ role: "user", content: "..." }],
  outputSchema,
  tools: [{ name, description, inputSchema }], // opcional
});
```

`instructions` e separado de mensagens do usuario. O adapter aceita somente mensagens `user`/`assistant`, encaminha apenas tools registradas e valida localmente tanto a saida quanto argumentos de tool calls.

Sucesso estruturado:

```json
{
  "status": "ok",
  "provider": "google",
  "model": "configured-model",
  "policy_version": "tutor-policy-v0.1",
  "output": {},
  "tool_calls": [],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5,
    "total_tokens": 15
  },
  "request_id": "provider-request-id",
  "attempts": 1,
  "error": null
}
```

Quando o modelo solicita uma tool registrada sem produzir a saida final, `status` e `tool_request`, `output` e `null` e `tool_calls` contem argumentos ja validados. B11 apenas devolve a solicitacao; nao executa a ferramenta.

Falha normalizada:

```json
{
  "status": "error",
  "provider": "google",
  "model": "configured-model",
  "policy_version": "tutor-policy-v0.1",
  "output": null,
  "tool_calls": [],
  "usage": null,
  "request_id": null,
  "attempts": 1,
  "error": {
    "category": "schema_validation_error",
    "code": "output_schema_mismatch",
    "message": "The LLM output did not match the expected schema.",
    "retryable": false
  }
}
```

Categorias publicas: `configuration_error`, `authentication_error`, `timeout`, `provider_error`, `invalid_response`, `schema_validation_error`, `invalid_tool_request` e `refusal`. Mensagens do provider, stack traces, payloads e credenciais nao sao copiados para o resultado.

## Provider

- `GoogleGeminiProvider`: implementa a Gemini API `generateContent` com `responseMimeType=application/json` e `responseJsonSchema`. Usa `fetch` injetavel e nao e importado pelo dominio.
- `FakeLlmProvider`: executa roteiros deterministas `valid`, `invalid`, `timeout`, `provider_error`, `authentication_error` e `refusal`, sem rede.

Retries sao limitados a `LLM_MAX_RETRIES` e aplicados somente a timeout/falha tecnica marcada como transitoria. Autenticacao, recusa, configuracao e formato invalido nao sao repetidos.

## Configuracao

```text
# Chave criada no Google AI Studio.
GOOGLE_API_KEY=...
OPENAI_MODEL=gemma-4-26b-a4b-it
LLM_POLICY_VERSION=...
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=1
LLM_MAX_OUTPUT_TOKENS=1200
LLM_EVAL_DELAY_MS=1000
LLM_TEMPERATURE=0
LLM_TOP_P=           # opcional
```

`createLlmAdapterFromEnv()` valida a configuracao antes da primeira chamada. A API key permanece em campo privado do provider e nao aparece em `adapter.configuration` nem em erros normalizados.

B12 carrega e compoe a Tutor Policy fora do adapter, preservando a independencia de provider de B11. O adapter continua sem ler `docs/TUTOR_POLICY.md` diretamente e não implementa PROBE, geracao de exercicios ou Orchestrator.
