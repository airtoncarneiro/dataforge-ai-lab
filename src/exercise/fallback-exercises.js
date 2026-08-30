// Catálogo determinístico usado somente quando a geração estruturada da LLM
// não produz um exercício compatível com as restrições do produto.
export const SELECT_FALLBACK_EXERCISES = Object.freeze([
  Object.freeze({
    id: "fallback-select-001",
    objective: "Praticar a seleção de colunas específicas da tabela customers.",
    statement: "Escreva uma consulta SQL para selecionar as colunas name e email de todos os registros da tabela customers.",
    expected_columns: Object.freeze(["name", "email"]),
    reference_query: "SELECT name, email FROM customers",
    source_relations: Object.freeze(["customers"]),
  }),
  Object.freeze({
    id: "fallback-select-002",
    objective: "Praticar a projeção de identificadores e atributos de clientes.",
    statement: "Escreva uma consulta SQL para selecionar as colunas customer_id e name de todos os registros da tabela customers.",
    expected_columns: Object.freeze(["customer_id", "name"]),
    reference_query: "SELECT customer_id, name FROM customers",
    source_relations: Object.freeze(["customers"]),
  }),
  Object.freeze({
    id: "fallback-select-003",
    objective: "Praticar a seleção de atributos de produtos.",
    statement: "Escreva uma consulta SQL para selecionar as colunas name e unit_price de todos os registros da tabela products.",
    expected_columns: Object.freeze(["name", "unit_price"]),
    reference_query: "SELECT name, unit_price FROM products",
    source_relations: Object.freeze(["products"]),
  }),
  Object.freeze({
    id: "fallback-select-004",
    objective: "Praticar a projeção de estoque e identificação de produtos.",
    statement: "Escreva uma consulta SQL para selecionar as colunas product_id e stock_quantity de todos os registros da tabela products.",
    expected_columns: Object.freeze(["product_id", "stock_quantity"]),
    reference_query: "SELECT product_id, stock_quantity FROM products",
    source_relations: Object.freeze(["products"]),
  }),
]);
