import { createLogEvent } from "./contracts.js";
import { redact } from "./redaction.js";

export class NullLogger {
  log() {}
}

export class ConsoleJsonLogger {
  constructor({ write = (line) => process.stdout.write(`${line}\n`) } = {}) {
    if (typeof write !== "function") throw new TypeError("write deve ser função.");
    this.write = write;
  }

  log(event) {
    this.write(JSON.stringify(redact(createLogEvent(event))));
  }
}

export class InMemoryLogger {
  #events = [];

  get events() {
    return Object.freeze(this.#events.map((event) => structuredClone(event)));
  }

  log(event) {
    this.#events.push(redact(createLogEvent(event)));
  }
}

export function emitSafely(logger, event) {
  try {
    logger.log(redact(createLogEvent(event)));
  } catch {
    // Observabilidade jamais altera o fluxo pedagógico ou operacional.
  }
}
