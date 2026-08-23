import { LlmProviderError } from "../errors.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parsedMessages(messages) {
  return messages.flatMap((message) => {
    try {
      return [JSON.parse(message.content)];
    } catch {
      return [];
    }
  });
}

function lastByKind(messages, kind) {
  return parsedMessages(messages).findLast((item) => item?.kind === kind) ?? null;
}

function applicationTask(messages) {
  return lastByKind(messages, "application_context")?.task ?? null;
}

function learnerAnswer(messages) {
  const directiveIndex = messages.findIndex((message) => {
    try {
      return JSON.parse(message.content)?.kind === "probe_evaluation_directive";
    } catch {
      return false;
    }
  });
  const candidates = messages.slice(0, directiveIndex).filter((message) => message.role === "user");
  return candidates.at(-1)?.content ?? "";
}

function probeQuestion(directive) {
  const labels = {
    conceptual: "Explique, com suas palavras, o papel de SELECT em uma consulta SQL.",
    explanatory: "Como você escolheria somente duas colunas de uma relação usando SELECT?",
    comparative: "Compare SELECT * com a projeção explícita de colunas e diga quando prefere cada forma.",
    small_problem: "Escreva apenas a ideia de uma consulta que liste customer_id e name da relação customers.",
  };
  return {
    question: labels[directive.question_type]
      ?? "Explique o que uma consulta SELECT faz.",
    targets: directive.targets,
    difficulty: directive.difficulty,
    question_type: directive.question_type,
    reason: "Pergunta diagnóstica determinística, sem revelar a resposta.",
  };
}

function probeEvaluation(directive, messages) {
  const answer = learnerAnswer(messages);
  const correct = !/(?:n[aã]o sei|errad|incorret|sem ideia)/iu.test(answer);
  const concept = directive.question.concept;
  return {
    assessment: {
      correct,
      conceptual_errors: correct ? [] : [{
        code: "probe_concept_gap",
        concept,
        description: "A resposta não demonstrou o conceito solicitado.",
      }],
      misconceptions: [],
      prerequisites_to_revisit: [],
    },
    mastery_evidence: [{
      concept,
      direction: correct ? "up" : "down",
      strength: "weak",
      reason: correct
        ? "A resposta aberta demonstrou compreensão inicial."
        : "A resposta aberta não forneceu evidência suficiente.",
    }],
    rationale: "Avaliação determinística do modo demo; o score final continua sob B08.",
  };
}

function exerciseOutput(directive, callNumber) {
  return {
    id: `demo-select-${callNumber}`,
    target_concepts: directive.target_concepts,
    difficulty: directive.difficulty,
    objective: "Projetar colunas específicas da relação customers.",
    statement: "Na relação customers, liste customer_id e name de todos os clientes, ordenando pelo customer_id.",
    expected_skills: [...directive.target_concepts],
    validation_strategy: "ORDERED_RESULT",
    evaluation_notes: ["Verificar projeção explícita e ordenação pelo identificador."],
    validation_metadata: {
      expected_columns: ["customer_id", "name"],
      comparison_mode: "ORDERED_RESULT",
      ordering_required: true,
      expected_row_count: 4,
      reference_query: "SELECT customer_id, name FROM customers ORDER BY customer_id",
      concepts_evaluated: directive.target_concepts,
      source_relations: ["customers"],
      constraints: [],
    },
  };
}

function evaluatorOutput(directive, context) {
  const correct = directive.objective_assessment.correct;
  const technical = ["execution_error", "security_violation", "timeout"].includes(
    directive.objective_assessment.status,
  );
  const concepts = context.relevant_concepts;
  return {
    pedagogical_assessment: {
      understanding: correct ? "partial" : technical ? "unknown" : "insufficient",
      reasoning_quality: correct ? "adequate" : "unclear",
      conceptual_errors: [],
      misconceptions: [],
      positive_evidence: correct ? concepts.map((concept) => ({
        concept,
        description: "A consulta satisfez a validação objetiva.",
        source: "validation",
      })) : [],
      negative_evidence: !correct && !technical ? concepts.map((concept) => ({
        concept,
        description: "O resultado objetivo não satisfez o exercício.",
        source: "validation",
      })) : [],
      prerequisites_to_revisit: [],
    },
    feedback: {
      message_to_learner: correct
        ? "A consulta produziu o resultado esperado. Explique mentalmente por que cada coluna foi selecionada."
        : technical
          ? "A consulta não pôde ser executada. Revise a mensagem do executor e tente novamente."
          : "O resultado ainda difere do esperado. Compare colunas, linhas e ordenação solicitadas.",
      hints: correct ? [] : ["Revise primeiro a projeção e a ordenação pedidas no enunciado."],
    },
    mastery_evidence: technical ? [] : concepts.map((concept) => ({
      concept,
      direction: correct ? "up" : "down",
      strength: correct ? "medium" : "weak",
      reason: correct
        ? "Resultado objetivo correto com estrutura compatível."
        : "Resultado objetivo divergente do exercício.",
    })),
    suggested_next_action: technical ? "retry" : "practice",
  };
}

function phaseOutput(task, context) {
  const concept = context.relevant_concepts[0];
  if (task === "plan") {
    return {
      message_to_learner: `Vamos consolidar ${concept} com uma explicação curta e prática deliberada.`,
      focus_concepts: [concept],
      sequence_rationale: "O plano usa o conceito recomendado pelo PROBE e respeita seus pré-requisitos.",
      next_action: "teach",
    };
  }
  if (task === "teach") {
    return {
      message_to_learner: "SELECT define quais expressões ou colunas uma consulta devolve. Prefira explicitar as colunas pedidas.",
      concepts: [concept],
      comprehension_check: "Quais colunas o enunciado pede que apareçam no resultado?",
      next_action: "practice",
    };
  }
  throw new LlmProviderError({
    category: "invalid_response",
    code: "unsupported_demo_task",
    message: "The deterministic demo does not implement this task.",
  });
}

export class DemoLlmProvider {
  #calls = [];

  get name() {
    return "demo";
  }

  get model() {
    return "deterministic-demo-v1";
  }

  get callCount() {
    return this.#calls.length;
  }

  get calls() {
    return clone(this.#calls);
  }

  async generate(request) {
    const { signal: _signal, ...publicRequest } = request;
    this.#calls.push(clone(publicRequest));
    const question = lastByKind(request.messages, "probe_question_directive");
    const probe = lastByKind(request.messages, "probe_evaluation_directive");
    const exercise = lastByKind(request.messages, "exercise_generation_directive");
    const evaluator = lastByKind(request.messages, "authoritative_result_validation");
    const context = lastByKind(request.messages, "application_context");
    const output = question
      ? probeQuestion(question)
      : probe
        ? probeEvaluation(probe, request.messages)
        : exercise
          ? exerciseOutput(exercise, this.#calls.length)
          : evaluator
            ? evaluatorOutput(evaluator, context)
            : phaseOutput(applicationTask(request.messages), context);
    return {
      type: "output",
      output,
      toolCalls: [],
      requestId: `demo-request-${this.#calls.length}`,
      usage: null,
    };
  }
}
