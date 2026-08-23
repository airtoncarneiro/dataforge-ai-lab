import process from "node:process";

import { createPostgresSessionStoreFromEnv } from "./postgres-session-store.js";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const store = createPostgresSessionStoreFromEnv();
try {
  await store.migrate();
  process.stdout.write("Migration B19 aplicada.\n");
} finally {
  await store.close();
}
