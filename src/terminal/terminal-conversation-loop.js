const EXIT_COMMANDS = new Set(["sair", "exit", "quit"]);

function exitCommand(value) {
  return EXIT_COMMANDS.has(value.trim().toLowerCase());
}

function scalar(value) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function table(columns, rows, limit) {
  if (columns.length === 0) return "(nenhuma coluna)";
  const visible = rows.slice(0, limit);
  const matrix = [columns, ...visible.map((row) => columns.map((column) => scalar(row[column])))];
  const widths = columns.map((_, index) => Math.min(
    40,
    Math.max(...matrix.map((line) => (line[index] ?? "").length)),
  ));
  const line = (values) => values.map(
    (value, index) => (value ?? "").slice(0, widths[index]).padEnd(widths[index]),
  ).join(" | ");
  const output = [line(columns), widths.map((width) => "-".repeat(width)).join("-+-")];
  output.push(...visible.map((row) => line(columns.map((column) => scalar(row[column])))));
  if (rows.length === 0) output.push("(0 linhas)");
  if (rows.length > limit) output.push(`... ${rows.length - limit} linha(s) não exibida(s)`);
  return output.join("\n");
}

function eventError(events) {
  return events.some((event) => event.type === "error");
}

export class TerminalConversationLoop {
  #application;
  #io;
  #maxDisplayRows;
  #lastSession = null;
  #presentedExerciseId = null;

  constructor({ application, io, maxDisplayRows = 20 }) {
    if (!application || ["start", "submitProbeAnswer", "prepareLearningCycle", "submitSql"]
      .some((method) => typeof application[method] !== "function")) {
      throw new TypeError("TerminalConversationLoop requer a aplicação B18.");
    }
    if (!io || typeof io.readLine !== "function" || typeof io.write !== "function") {
      throw new TypeError("TerminalConversationLoop requer I/O injetável.");
    }
    if (!Number.isSafeInteger(maxDisplayRows) || maxDisplayRows < 1) {
      throw new TypeError("maxDisplayRows deve ser inteiro positivo.");
    }
    this.#application = application;
    this.#io = io;
    this.#maxDisplayRows = maxDisplayRows;
  }

  async run() {
    this.#io.write("SQL Mentor AI — conversa de terminal B18");
    this.#io.write("Digite 'sair' a qualquer momento para encerrar.");
    let reason = "completed";
    try {
      const learningGoal = await this.#io.readLine("Objetivo de aprendizagem> ");
      if (learningGoal === null) return this.#finish("eof");
      if (exitCommand(learningGoal)) return this.#finish("manual_exit");
      let result = await this.#application.start({ learningGoal });
      this.#accept(result);
      if (eventError(result.events) || result.session.status === "error") {
        return this.#finish("application_error");
      }

      while (this.#lastSession?.status === "active") {
        const phase = this.#lastSession.phase;
        if (phase === "PROBE") {
          const answer = await this.#io.readLine("Sua resposta> ");
          if (answer === null) return this.#finish(this.#io.interrupted ? "interrupt" : "eof");
          if (exitCommand(answer)) return this.#finish("manual_exit");
          if (answer.trim() === "") {
            this.#io.write("[ERRO] A resposta do diagnóstico não pode ficar vazia.");
            continue;
          }
          result = await this.#application.submitProbeAnswer(answer);
          this.#accept(result);
          if (eventError(result.events) || result.session.status === "error") {
            return this.#finish("application_error");
          }
          continue;
        }

        if (phase === "PRACTICE" && this.#lastSession.current_exercise_id !== null
          && this.#presentedExerciseId === this.#lastSession.current_exercise_id) {
          const submission = await this.#readSql();
          if (submission.reason !== null) return this.#finish(submission.reason);
          this.#presentedExerciseId = null;
          result = await this.#application.submitSql(submission.sql);
          this.#accept(result);
          if (eventError(result.events) || result.session.status === "error") {
            return this.#finish("application_error");
          }
          continue;
        }

        if (["PLAN", "TEACH", "PRACTICE", "REVIEW", "APPLY", "TRANSFER_TEST"]
          .includes(phase)) {
          result = await this.#application.prepareLearningCycle();
          this.#accept(result);
          if (eventError(result.events) || result.session.status === "error") {
            return this.#finish("application_error");
          }
          continue;
        }

        if (phase === "COMPLETED") {
          reason = "completed";
          break;
        }
        this.#io.write(`[ERRO] Estado inesperado do fluxo: ${phase}.`);
        reason = "application_error";
        break;
      }
      return this.#finish(reason);
    } catch {
      this.#io.write("[ERRO] A sessão encontrou uma falha interna sanitizada.");
      return this.#finish("application_error");
    } finally {
      try {
        await this.#application.close?.();
      } catch {
        this.#io.write("[ERRO] Não foi possível liberar um recurso da sessão.");
      }
      this.#io.close?.();
    }
  }

  async #readSql() {
    this.#io.write("Digite a SQL em uma ou mais linhas. Finalize com .enviar em uma linha separada.");
    const lines = [];
    while (true) {
      const line = await this.#io.readLine(lines.length === 0 ? "sql> " : "...> ");
      if (line === null) {
        return { sql: null, reason: this.#io.interrupted ? "interrupt" : "eof" };
      }
      if (lines.length === 0 && exitCommand(line)) {
        return { sql: null, reason: "manual_exit" };
      }
      if (line.trim().toLowerCase() === ".enviar") {
        if (lines.join("\n").trim() === "") {
          this.#io.write("[ERRO] Escreva uma consulta antes de .enviar.");
          continue;
        }
        return { sql: lines.join("\n"), reason: null };
      }
      lines.push(line);
    }
  }

  #accept(result) {
    this.#lastSession = result.session;
    for (const event of result.events) this.#render(event);
  }

  #render(event) {
    const data = event.data;
    switch (event.type) {
      case "welcome":
        this.#io.write(`\n[TUTOR] ${data.message}`);
        break;
      case "probe_question":
        this.#io.write(`\n[PROBE ${data.number}/${data.max_questions}] ${data.question}`);
        break;
      case "probe_completed":
        this.#io.write(`\n[PROBE CONCLUÍDO] Motivo: ${data.completion_reason}. Próximo conceito: ${data.next_concept_recommended ?? "revisão"}.`);
        break;
      case "plan":
        this.#io.write(`\n[PLANO] ${data.message}\nFoco: ${data.focus_concepts.join(", ")}`);
        break;
      case "teach":
        this.#io.write(`\n[TUTOR] ${data.message}\nChecagem: ${data.comprehension_check}`);
        break;
      case "review_placeholder":
        this.#io.write(`\n[REVISÃO] ${data.message}`);
        break;
      case "exercise":
        this.#presentedExerciseId = data.id;
        this.#io.write(`\n[EXERCÍCIO — dificuldade ${data.difficulty}]\nObjetivo: ${data.objective}\n${data.statement}`);
        break;
      case "execution":
        this.#io.write(`\n[RESULTADO SQL] status=${data.status} duração=${data.duration_ms.toFixed(2)}ms`);
        if (data.error) {
          this.#io.write(`Erro: ${data.error.category} — ${data.error.message}`);
        } else {
          this.#io.write(table(data.columns, data.rows, this.#maxDisplayRows));
          this.#io.write(`Linhas: ${data.row_count}${data.truncated ? " (resultado truncado)" : ""}`);
        }
        break;
      case "feedback":
        this.#io.write(`\n[FEEDBACK DO TUTOR] ${data.message}`);
        data.hints.forEach((hint, index) => this.#io.write(`Dica ${index + 1}: ${hint}`));
        break;
      case "progress":
        this.#io.write("\n[PROGRESSO]");
        data.concepts.forEach((concept) => this.#io.write(
          `${concept.concept}: mastery=${concept.mastery.toFixed(2)} confidence=${concept.confidence} (${concept.classification})`,
        ));
        break;
      case "decision":
        this.#io.write(`\n[PRÓXIMA AÇÃO] ${data.action}${data.next_concept ? ` → ${data.next_concept}` : ""}\nMotivo: ${data.rationale}`);
        break;
      case "error":
        this.#io.write(`\n[ERRO] ${data.message} (${data.code})`);
        break;
      case "session_ended":
        this.#io.write(`\n[SESSÃO ENCERRADA] ${data.message}`);
        break;
      default:
        break;
    }
  }

  #finish(reason) {
    const ended = this.#application.endSession?.(reason);
    if (ended) this.#accept(ended);
    return Object.freeze({ reason, session: this.#lastSession });
  }
}
