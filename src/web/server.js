import { createServer } from "node:http";
import { createTutorApplicationFromEnv } from "../orchestrator/index.js";

const HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SQL Mentor AI</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px;color:#17202a}textarea{width:100%;min-height:100px;margin:8px 0}button{padding:10px 16px;margin:4px 0;cursor:pointer}#output{white-space:pre-wrap;background:#f4f6f7;padding:16px;border-radius:8px;min-height:80px}.muted{color:#667}</style></head><body><h1>SQL Mentor AI</h1><p class="muted">Tutor adaptativo de SQL com execução controlada no PostgreSQL.</p><button id="start">Iniciar sessão</button><div id="session"></div><div id="output">Inicie uma sessão para começar.</div><script>let id,phase;const out=document.querySelector('#output'),box=document.querySelector('#session');const show=x=>{out.textContent=JSON.stringify(x,null,2)};const prepare=async()=>{const r=await fetch('/api/sessions/'+id+'/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const j=await r.json();phase=j.session?.phase??phase;show(j)};document.querySelector('#start').onclick=async()=>{const r=await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({learning_goal:'Quero aprender SQL'})});const j=await r.json();id=j.session_id;phase=j.phase;box.innerHTML='<textarea id="answer" placeholder="Resposta do diagnóstico ou SQL"></textarea><br><button id="send">Enviar resposta</button>';document.querySelector('#send').onclick=async()=>{const value=document.querySelector('#answer').value;const path=phase==='PROBE'?'/probe':'/sql';const r2=await fetch('/api/sessions/'+id+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(path==='/probe'?{answer:value}:{sql:value})});const next=await r2.json();phase=next.session?.phase??phase;show(next);if(phase==='PLAN')await prepare()};show(j)};</script></body></html>`;

async function jsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw Object.assign(new Error("request_too_large"), { statusCode: 413 });
  }
  return body === "" ? {} : JSON.parse(body);
}

function send(response, status, payload, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export function createMentorWebServer({ env = process.env, applicationFactory = createTutorApplicationFromEnv } = {}) {
  const sessions = new Map();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, HTML, { "content-type": "text/html; charset=utf-8" });
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok", service: "sql-mentor-ai" });
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const body = await jsonBody(request);
        const application = await applicationFactory({ env });
        const result = await application.start({ learningGoal: body.learning_goal ?? "Quero aprender SQL" });
        const sessionId = result.session_id ?? result.session?.id;
        if (!sessionId) { await application.close?.(); return send(response, 500, { error: "session_id_missing" }); }
        sessions.set(sessionId, application);
        return send(response, 201, { session_id: sessionId, phase: result.phase ?? result.session?.phase, result });
      }
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(probe|prepare|sql))?$/);
      if (!match || !sessions.has(match[1])) return send(response, 404, { error: "session_not_found" });
      const application = sessions.get(match[1]);
      if (request.method === "GET" && !match[2]) return send(response, 200, { session_id: match[1], phase: application.session?.flow_state?.phase ?? null });
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      const body = await jsonBody(request);
      let result;
      if (match[2] === "probe") result = await application.submitProbeAnswer(body.answer);
      else if (match[2] === "prepare") result = await application.prepareLearningCycle();
      else result = await application.submitSql(body.sql);
      return send(response, 200, result);
    } catch (error) {
      return send(response, error.statusCode ?? 400, { error: error.statusCode === 413 ? "request_too_large" : "invalid_request" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createMentorWebServer();
  server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => console.log("SQL Mentor AI web em http://127.0.0.1:3000"));
}
