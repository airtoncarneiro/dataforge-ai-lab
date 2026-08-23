import { KnowledgeGraph } from "./knowledge-graph.js";

export const SQL_KNOWLEDGE_GRAPH_DEFINITION = Object.freeze({
  version: "sql-knowledge-graph-v1",
  nodes: Object.freeze([
    {
      id: "select",
      label: "SELECT",
      description: "Projeção e leitura básica de relações.",
      prerequisites: [],
    },
    {
      id: "where",
      label: "WHERE",
      description: "Filtragem de linhas por predicados.",
      prerequisites: ["select"],
    },
    {
      id: "order_by",
      label: "ORDER BY",
      description: "Ordenação determinística de resultados.",
      prerequisites: ["select"],
    },
    {
      id: "null",
      label: "NULL",
      description: "Valores ausentes e lógica SQL de três valores.",
      prerequisites: ["select"],
    },
    {
      id: "case",
      label: "CASE",
      description: "Expressões condicionais e tratamento explícito de alternativas.",
      prerequisites: ["select", "null"],
    },
    {
      id: "aggregate_functions",
      label: "Aggregate functions",
      description: "Cálculos que resumem conjuntos de linhas.",
      prerequisites: ["select"],
    },
    {
      id: "group_by",
      label: "GROUP BY",
      description: "Particionamento de linhas para agregação por grupo.",
      prerequisites: ["aggregate_functions"],
    },
    {
      id: "having",
      label: "HAVING",
      description: "Filtragem de grupos após agregação.",
      prerequisites: ["group_by", "where"],
    },
    {
      id: "join",
      label: "JOIN",
      description: "Combinação de relações, cardinalidade e semântica inner/outer.",
      prerequisites: ["select", "null"],
    },
    {
      id: "subqueries",
      label: "Subqueries",
      description: "Composição de consultas aninhadas e seus escopos.",
      prerequisites: ["select", "where"],
    },
    {
      id: "cte",
      label: "CTE",
      description: "Nomeação e decomposição de resultados intermediários com WITH.",
      prerequisites: ["subqueries"],
    },
    {
      id: "window_functions",
      label: "Window functions",
      description: "Cálculos analíticos que preservam a granularidade das linhas.",
      prerequisites: ["select", "aggregate_functions", "order_by"],
    },
    {
      id: "date_time",
      label: "Date/time",
      description: "Tipos, operações e filtros temporais.",
      prerequisites: ["select", "where"],
    },
    {
      id: "indexes",
      label: "Indexes",
      description: "Estruturas de acesso para filtros, ordenações e junções.",
      prerequisites: ["where", "order_by", "join"],
    },
    {
      id: "explain",
      label: "EXPLAIN",
      description: "Leitura de planos para consultas com acesso, joins e agregações.",
      prerequisites: ["select", "join", "aggregate_functions"],
    },
    {
      id: "query_optimization",
      label: "Query optimization",
      description: "Análise e melhoria de consultas com evidência do plano.",
      prerequisites: ["indexes", "explain"],
    },
  ].map((node) => Object.freeze({
    ...node,
    prerequisites: Object.freeze([...node.prerequisites]),
  }))),
});

export function createSqlKnowledgeGraph() {
  return new KnowledgeGraph(SQL_KNOWLEDGE_GRAPH_DEFINITION);
}

export const SQL_KNOWLEDGE_GRAPH = createSqlKnowledgeGraph();
