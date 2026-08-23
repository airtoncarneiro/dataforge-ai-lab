import { createInterface } from "node:readline";

export class NodeTerminalIO {
  #output;
  #terminal;
  #iterator;
  #closed = false;
  #interrupted = false;

  constructor({ input, output }) {
    if (!input || typeof input.on !== "function") {
      throw new TypeError("NodeTerminalIO requer um stream de entrada.");
    }
    if (!output || typeof output.write !== "function") {
      throw new TypeError("NodeTerminalIO requer um stream de saída.");
    }
    this.#output = output;
    this.#terminal = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
      crlfDelay: Infinity,
    });
    this.#iterator = this.#terminal[Symbol.asyncIterator]();
    this.#terminal.on("SIGINT", () => {
      this.#interrupted = true;
      this.close();
    });
  }

  get interrupted() {
    return this.#interrupted;
  }

  async readLine(prompt = "") {
    if (this.#closed) return null;
    if (prompt) this.#output.write(prompt);
    const { value, done } = await this.#iterator.next();
    if (done) {
      this.#closed = true;
      return null;
    }
    return value;
  }

  write(value = "") {
    const text = String(value);
    this.#output.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#terminal.close();
    }
  }
}
