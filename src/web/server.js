import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createTutorApplicationFromEnv } from "../orchestrator/index.js";

const HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DataForge AI Lab</title>
<style>
:root{font:16px system-ui,sans-serif;color:#17202a;background:#f6f8fa}body{max-width:920px;margin:0 auto;padding:28px 18px 56px}header,section,.card{background:#fff;border:1px solid #d9e0e6;border-radius:12px;padding:20px;margin:14px 0}h1,h2,h3{margin-top:0}.muted{color:#667085}.status{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.pill{background:#eef2ff;color:#3730a3;border-radius:999px;padding:5px 10px;font-size:.9rem}textarea,input{box-sizing:border-box;width:100%;border:1px solid #b8c2cc;border-radius:8px;padding:10px;font:inherit}textarea{min-height:130px;resize:vertical}#sql,code,pre{font-family:ui-monospace,SFMono-Regular,monospace}code{background:#eef2f7;border-radius:4px;padding:1px 4px}pre{background:#0f172a;color:#e5e7eb;border-radius:8px;overflow:auto;padding:12px}pre code{background:transparent;padding:0}button{border:0;border-radius:8px;padding:10px 15px;margin:8px 8px 0 0;font:inherit;cursor:pointer;background:#2563eb;color:#fff}button.secondary{background:#e5e7eb;color:#17202a}button:disabled{opacity:.55;cursor:wait}.hidden{display:none!important}.error{background:#fef2f2;color:#991b1b;border-color:#fecaca}.feedback{line-height:1.5}table{border-collapse:collapse;width:100%;margin-top:10px}th,td{border-bottom:1px solid #e5e7eb;text-align:left;padding:7px}
</style></head>
<body><header><h1>DataForge AI Lab</h1><div class="muted">Laboratório adaptativo para estudantes de engenharia de dados.</div><div id="status" class="status"><span class="pill">Sessão não iniciada</span></div></header>
<section id="startPanel"><h2>Comece sua sessão</h2><label for="goal">O que você quer aprender?</label><input id="goal" value="Quero aprender SQL"><button id="start">Iniciar nova sessão</button><label for="resumeId">ID de outra sessão (opcional)</label><input id="resumeId" placeholder="learning-session:..."><button id="resume" class="secondary">Retomar última sessão</button></section>
<section id="content" class="hidden"><h2 id="phaseTitle">Diagnóstico</h2><div id="busy" class="card hidden" role="status" aria-live="polite">Processando… aguarde.</div><div id="message" class="feedback"></div><div id="exercise" class="card hidden"></div><div id="progress" class="card hidden"></div><div id="error" class="card error hidden"></div><div id="inputPanel" class="card hidden"><label id="inputLabel" for="answer">Resposta</label><textarea id="answer" placeholder="Digite sua resposta"></textarea><button id="send">Enviar</button><button id="preview" class="secondary hidden">Testar SQL</button><button id="continue" class="hidden">Continuar</button></div><div id="executionResult" class="card hidden"></div></section>
<script>
const state={id:null,phase:null,busy:false};const el=id=>document.getElementById(id);const phaseNames={PROBE:"Diagnóstico",PLAN:"Plano",TEACH:"Ensino",PRACTICE:"Prática",REVIEW:"Revisão",APPLY:"Apply",TRANSFER_TEST:"Transfer Test"};const setBusy=value=>{state.busy=value;document.querySelectorAll("button").forEach(button=>{button.disabled=value})};const show=(node,value)=>node.classList.toggle("hidden",!value);const text=value=>value===null||value===undefined?"":String(value);const escapeHtml=value=>text(value).replace(/[&<>\"']/gu,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[character]));
function renderMarkdown(value){const tick=String.fromCharCode(96);return escapeHtml(value).replace(new RegExp(tick+tick+tick+"([\\\\s\\\\S]*?)"+tick+tick+tick,"gu"),"<pre><code>$1</code></pre>").replace(/^### (.*)$/gmu,"<h3>$1</h3>").replace(/^## (.*)$/gmu,"<h2>$1</h2>").replace(/\\*\\*([^*]+)\\*\\*/gu,"<strong>$1</strong>").replace(new RegExp(tick+"([^"+tick+"]+)"+tick,"gu"),"<code>$1</code>").replace(/\\n\\n/gu,"</p><p>").replace(/\\n/gu,"<br>")}
function setMarkdown(node,value){node.innerHTML="<p>"+renderMarkdown(value)+"</p>"}
function setStatus(){el("status").innerHTML='<span class="pill">Sessão: '+escapeHtml(state.id)+'</span><span class="pill">Fase: '+escapeHtml(phaseNames[state.phase]||state.phase)+'</span>'}
function reconcileControls(){const input=document.querySelector("#answer,#sql");if(state.phase==="PROBE"){input.id="answer";input.value="";show(input,true);show(el("inputLabel"),true);el("inputLabel").textContent="Sua resposta";show(el("inputPanel"),true);show(el("send"),true);show(el("preview"),false);show(el("continue"),false)}else if(["PLAN","TEACH","REVIEW","APPLY","TRANSFER_TEST"].includes(state.phase)){input.id="answer";input.value="";show(input,false);show(el("inputLabel"),false);show(el("inputPanel"),true);show(el("send"),false);show(el("preview"),false);show(el("continue"),true)}else if(state.phase==="PRACTICE"){const hasExercise=!el("exercise").classList.contains("hidden")&&el("exercise").textContent.trim()!=="";show(input,hasExercise);show(el("inputLabel"),hasExercise);show(el("inputPanel"),true);show(el("send"),hasExercise);show(el("preview"),hasExercise);show(el("continue"),!hasExercise)}}
function renderRows(data){if(!data||!Array.isArray(data.columns))return "";const head=data.columns.map(column=>"<th>"+escapeHtml(column)+"</th>").join("");const rows=(data.rows||[]).map(row=>"<tr>"+data.columns.map(column=>"<td>"+escapeHtml(row[column])+"</td>").join("")+"</tr>").join("");return '<table><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table><div class="muted">Linhas: '+escapeHtml(data.row_count)+'</div>'}
function formatSchemaTerms(value){return text(value).replace(/\b(customer_id|product_id|category_id|department_id|employee_id|order_id|name|email|city|unit_price|customers|products|orders|order_items|categories|employees|departments)\b/gu,"\`$1\`")}
function renderEvent(event){
  const data=event.data||{};
  if(event.type==="session_resumed"){setMarkdown(el("message"),data.message||"Sessão retomada.");show(el("inputPanel"),true);show(el("send"),false);show(el("preview"),false);show(el("continue"),true)}
  else if(event.type==="probe_question"){const input=document.querySelector("textarea");el("message").textContent="Pergunta "+text(data.number)+"/"+text(data.max_questions)+"\\n\\n"+text(data.question);el("inputLabel").textContent="Sua resposta";input.id="answer";input.value="";input.placeholder="Explique com suas palavras";show(input,true);show(el("inputPanel"),true);show(el("send"),true);show(el("preview"),false);show(el("continue"),false)}
  else if(event.type==="probe_completed"){const input=document.querySelector("textarea");setMarkdown(el("message"),data.summary||data.message||"Diagnóstico concluído. Avance para o plano pedagógico.");el("inputLabel").textContent="Próxima etapa";input.id="answer";input.value="";show(el("inputPanel"),true);show(el("send"),false);show(el("preview"),false);show(el("continue"),true)}
  else if(["plan","teach","review","apply","transfer_test"].includes(event.type)){setMarkdown(el("message"),text(data.message)+(data.comprehension_check?"\\n\\nChecagem: "+data.comprehension_check:""));show(el("inputPanel"),true);show(el("send"),false);show(el("preview"),false);show(el("continue"),true)}
  else if(event.type==="exercise"){const input=document.querySelector("textarea");setMarkdown(el("exercise"),"Exercício\\n\\nObjetivo: "+text(data.objective)+"\\n\\n"+formatSchemaTerms(data.statement)+"\\n\\nDificuldade "+text(data.difficulty)+" · "+text((data.concepts||[]).join(", ")));show(el("exercise"),true);el("inputLabel").textContent="Sua SQL";input.id="sql";input.value="";input.placeholder="SELECT ...";el("executionResult").innerHTML="";show(el("executionResult"),false);show(el("inputPanel"),true);show(el("send"),true);show(el("preview"),true);show(el("continue"),false)}
  else if(event.type==="preview_execution"||event.type==="execution"){const result=el("executionResult");result.innerHTML="<h3>"+(event.type==="preview_execution"?"Prévia da execução":"Resultado da avaliação")+"</h3>"+(data.error?"<p>Erro: "+escapeHtml(data.error.message||data.error.category)+"</p>":renderRows(data));show(result,true)}
  else if(event.type==="feedback"){setMarkdown(el("message"),data.message)}
  else if(event.type==="progress"){el("progress").textContent="Progresso\\n\\n"+(data.concepts||[]).map(item=>text(item.concept)+": "+text(Number(item.mastery).toFixed(2))+" ("+text(item.confidence)+")").join("\\n");show(el("progress"),true)}
  else if(event.type==="decision"){const action=data.action||data.next_action;el("message").innerHTML+="<p>Próxima ação: "+escapeHtml(action)+"</p>";if(action!=="retry"){const sql=el("sql");if(sql)sql.value="";show(el("exercise"),false);show(el("send"),false);show(el("preview"),false)}}
  else if(event.type==="error"){el("error").textContent=text(data.message||"A operação não pôde ser concluída.");show(el("error"),true)}
}
function renderResult(result){show(el("error"),false);if(result.session_id)state.id=result.session_id;if(result.session&&result.session.phase)state.phase=result.session.phase;if(result.phase)state.phase=result.phase;if(state.id)localStorage.setItem("sql-mentor-last-session",state.id);show(el("content"),true);setStatus();(result.events||[]).forEach(renderEvent);reconcileControls();el("phaseTitle").textContent=phaseNames[state.phase]||"Sessão"}
async function request(path,body){const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});const result=await response.json();if(!response.ok)throw new Error(result.error||"request_failed");return result}
async function prepare(){setBusy(true);try{renderResult(await request("/api/sessions/"+encodeURIComponent(state.id)+"/prepare"))}catch(error){el("error").textContent=error.message;show(el("error"),true)}finally{setBusy(false)}}
el("start").onclick=async()=>{setBusy(true);el("message").textContent="Iniciando sessão e preparando o diagnóstico…\\n\\nA primeira resposta pode levar alguns segundos.";show(el("content"),true);try{renderResult(await request("/api/sessions",{learning_goal:el("goal").value}));show(el("startPanel"),false)}catch(error){el("error").textContent="Não foi possível iniciar a sessão: "+error.message;show(el("content"),true);show(el("error"),true)}finally{setBusy(false)}};el("resume").onclick=async()=>{setBusy(true);el("message").textContent="Retomando sessão…";show(el("content"),true);try{const id=el("resumeId").value.trim();renderResult(await request("/api/sessions/"+encodeURIComponent(id)+"/resume"));show(el("startPanel"),false)}catch(error){el("error").textContent="Não foi possível retomar a sessão: "+error.message;show(el("content"),true);show(el("error"),true)}finally{setBusy(false)}};el("send").onclick=async()=>{setBusy(true);try{const path=state.phase==="PROBE"?"/probe":"/sql";const field=state.phase==="PROBE"?"answer":"sql";renderResult(await request("/api/sessions/"+encodeURIComponent(state.id)+path,state.phase==="PROBE"?{answer:el(field).value}:{sql:el(field).value}))}catch(error){el("error").textContent=error.message;show(el("error"),true)}finally{setBusy(false)}};el("preview").onclick=async()=>{setBusy(true);try{renderResult(await request("/api/sessions/"+encodeURIComponent(state.id)+"/preview",{sql:el("sql").value}))}catch(error){el("error").textContent=error.message;show(el("error"),true)}finally{setBusy(false)}};el("continue").onclick=prepare;
</script><script>
document.getElementById("resume").onclick=async()=>{
  setBusy(true);el("message").textContent="Retomando sessão…";show(el("content"),true);
  try{
    const id=el("resumeId").value.trim()||localStorage.getItem("sql-mentor-last-session")||"latest";
    renderResult(await request("/api/sessions/"+encodeURIComponent(id)+"/resume"));
    show(el("startPanel"),false);
  }catch(error){el("error").textContent="Não foi possível retomar a sessão: "+error.message;show(el("content"),true);show(el("error"),true)}
  finally{setBusy(false)}
};
</script></body></html>`;

async function jsonBody(request) { let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 1_000_000) throw Object.assign(new Error("request_too_large"), { statusCode: 413 }); } return body === "" ? {} : JSON.parse(body); }
function send(response, status, payload, headers = {}) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); response.end(typeof payload === "string" ? payload : JSON.stringify(payload)); }
function phaseOf(application) { return application.session?.flow_state?.phase ?? application.session?.phase ?? null; }
function createResumeEvents(application, events = []) {
  const session = application.session;
  const resumed = { type: "session_resumed", data: { session_id: session?.id, phase: phaseOf(application), message: "Sessão recuperada do estado persistido." } };
  const currentExercise = session?.current_exercise?.exercise;
  if (!currentExercise || !["PRACTICE", "APPLY", "TRANSFER_TEST"].includes(phaseOf(application))) {
    return [resumed, ...events];
  }
  return [resumed, ...events, {
    type: "exercise",
    data: {
      objective: currentExercise.objective,
      statement: currentExercise.statement,
      difficulty: currentExercise.difficulty,
      concepts: currentExercise.concepts,
    },
  }];
}

async function loadDotEnv() {
  try {
    const content = await readFile(new URL("../../.env", import.meta.url), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* .env is optional when CI injects variables */ }
}

export function createMentorWebServer({ env = process.env, applicationFactory = createTutorApplicationFromEnv } = {}) {
  const sessions = new Map();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, HTML, { "content-type": "text/html; charset=utf-8" });
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { status: "ok", service: "dataforge-ai-lab" });
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const body = await jsonBody(request); const application = await applicationFactory({ env });
        const result = await application.start({ learningGoal: body.learning_goal ?? "Quero aprender SQL" }); const sessionId = result.session_id ?? result.session?.id;
        if (!sessionId) { await application.close?.(); return send(response, 500, { error: "session_id_missing" }); }
        sessions.set(sessionId, application); return send(response, 201, { session_id: sessionId, phase: phaseOf(application), events: result.events, session: result.session });
      }
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(probe|prepare|sql|preview|resume))?$/);
      const sessionId = match ? decodeURIComponent(match[1]) : null;
      if (request.method === "POST" && sessionId && match?.[2] === "resume") {
        if (sessions.has(sessionId)) return send(response, 200, { session_id: sessionId, phase: phaseOf(sessions.get(sessionId)), events: createResumeEvents(sessions.get(sessionId)), session: sessions.get(sessionId).session });
        const application = await applicationFactory({ env });
        const result = sessionId === "latest"
          ? await application.resumeLatest()
          : await application.resume(sessionId);
        sessions.set(sessionId, application);
        return send(response, 200, { session_id: sessionId, phase: phaseOf(application), events: createResumeEvents(application, result.events), session: result.session });
      }
      if (!sessionId || !sessions.has(sessionId)) return send(response, 404, { error: "session_not_found" });
      const application = sessions.get(sessionId);
      if (request.method === "GET" && !match[2]) return send(response, 200, { session_id: sessionId, phase: phaseOf(application) });
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      const body = await jsonBody(request); let result;
      if (match[2] === "probe") result = await application.submitProbeAnswer(body.answer);
      else if (match[2] === "prepare") result = await application.prepareLearningCycle();
      else if (match[2] === "preview") result = await application.previewSql(body.sql);
      else result = await application.submitSql(body.sql);
      return send(response, 200, result);
    } catch (error) { return send(response, error.statusCode ?? 400, { error: error.statusCode === 413 ? "request_too_large" : "invalid_request" }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) { await loadDotEnv(); const server = createMentorWebServer(); server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => console.log("DataForge AI Lab web em http://127.0.0.1:3000")); }
