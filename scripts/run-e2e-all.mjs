// Runs every end-to-end suite against an already running, seeded stack
// (`pnpm demo:up`). Used locally and by .github/workflows/e2e.yml.
import { spawnSync } from "node:child_process";

const SUITES = [
  ["demo:verify", "standard demo baseline"],
  ["demo:verify:flow", "deposit -> trade -> withdrawal main flow (API)"],
  ["test:features", "M2–M5 features: API keys, WS hardening, fees + T-accounts, SOL-USDT, notifications, 2FA/KYC/dual approval, fault lab"],
  ["test:trader-web:local", "trader-web UI end to end"],
  ["test:ops-console:local", "ops-console UI end to end"]
];

const results = [];
for (const [script, description] of SUITES) {
  console.log(`\n==> ${script}: ${description}`);
  const startedAt = Date.now();
  const run = spawnSync("pnpm", ["-s", script], { stdio: "inherit" });
  results.push({ script, ok: run.status === 0, seconds: Math.round((Date.now() - startedAt) / 1000) });
  if (run.status !== 0) {
    break;
  }
}

console.log("\nE2E summary");
for (const result of results) {
  console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.script} (${result.seconds}s)`);
}
process.exit(results.every((result) => result.ok) && results.length === SUITES.length ? 0 : 1);
