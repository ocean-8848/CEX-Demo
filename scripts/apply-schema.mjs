// Runs every service's already-built migration runner (dist/scripts/run-db-prepare.js)
// in dependency order. Pending SQL files are applied once; when nothing is pending
// this only compares schema_migrations with the files on disk. Used by
// stack:start after its build; `pnpm db:prepare:demo` is the build-then-apply variant.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SCHEMA_ORDER = [
  "services/ledger-service",
  "services/identity-service",
  "services/wallet-service",
  "services/blockchain-indexer",
  "services/custody-adapter",
  "services/order-service",
  "services/settlement-service",
  "services/risk-service",
  "apps/ops-console"
];

for (const dir of SCHEMA_ORDER) {
  const runner = path.join(rootDir, dir, "dist/scripts/run-db-prepare.js");
  if (!existsSync(runner)) {
    throw new Error(`${dir} is not built (missing ${path.relative(rootDir, runner)}); run pnpm build first`);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], { cwd: path.join(rootDir, dir), stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${dir}: schema migration failed (exit ${code})`))));
    child.on("error", reject);
  });
}
