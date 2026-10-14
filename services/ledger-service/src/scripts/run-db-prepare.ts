// Applies this service's pending SQL migrations once and records them in
// schema_migrations; a restart with nothing new is a no-op.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSchemaMigrations } from "@web3-cex/domain/schema-migrations";

import { createLedgerPool } from "../infrastructure/postgres.js";

async function main(): Promise<void> {
  const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sql");
  const pool = createLedgerPool();
  try {
    await runSchemaMigrations(pool, { service: "ledger-service", sqlDir });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
