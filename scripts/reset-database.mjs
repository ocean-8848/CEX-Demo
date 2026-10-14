// Drops the demo database and recreates it from the current schema (each
// service's sql/ baseline), discarding all data and any older, untracked schema.
// Usage: pnpm db:reset [--no-prepare]
// Afterwards seed demo data with `pnpm demo:prepare` (or start everything with
// `pnpm demo:up`). Stop the stack first: running services lose their connections.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { loadDemoConfig } from "./mvp-demo-lib.mjs";

const pgRequire = createRequire(new URL("../services/ledger-service/package.json", import.meta.url));
const pgModule = await import(pgRequire.resolve("pg"));
const PgClient = pgModule.Client ?? pgModule.default?.Client;

const skipPrepare = process.argv.includes("--no-prepare");
const target = new URL(loadDemoConfig().databaseUrl);
const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (!/^[a-z_][a-z0-9_]*$/i.test(database)) {
  throw new Error(`refusing to reset unexpected database name: ${database}`);
}

const maintenance = new URL(target);
maintenance.pathname = "/postgres";
const admin = new PgClient({ connectionString: maintenance.toString() });
await admin.connect();
try {
  console.log(`==> drop database ${database}`);
  await admin.query(`drop database if exists "${database}" with (force)`);
  console.log(`==> create database ${database}`);
  await admin.query(`create database "${database}"`);
} finally {
  await admin.end();
}

if (!skipPrepare) {
  console.log("==> apply schema (pnpm db:prepare:demo)");
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["db:prepare:demo"], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`db:prepare:demo exited with ${code}`))));
    child.on("error", reject);
  });
}

console.log(`\nDatabase ${database} recreated from the current schema. Seed demo data with: pnpm demo:prepare`);
