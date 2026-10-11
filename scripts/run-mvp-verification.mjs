import { spawn } from "node:child_process";

const commands = [
  {
    label: "matching-engine regression suite",
    command: "cargo",
    args: ["test", "--manifest-path", "engines/matching-engine/Cargo.toml"]
  },
  {
    label: "market config single-source check (config/markets.json)",
    command: "pnpm",
    args: ["check:markets"]
  },
  {
    label: "ops-console tests",
    command: "pnpm",
    args: ["--filter", "@web3-cex/ops-console", "test"]
  },
  {
    label: "trader-web smoke tests",
    command: "pnpm",
    args: ["--filter", "@web3-cex/trader-web", "test"]
  },
  {
    label: "trade-domain replay verification",
    command: "node",
    args: ["./scripts/test-trade-domain-replay.mjs"]
  }
];

if (readBooleanEnv("DEMO_MAIN_FLOW_VERIFY", false)) {
  commands.push({
    label: "cross-service demo main-flow verification",
    command: "node",
    args: ["./scripts/verify-demo-main-flow.mjs"]
  });
}

if (readBooleanEnv("TRADER_WEB_LOCAL_E2E", false)) {
  commands.push({
    label: "trader-web local browser verification",
    command: "node",
    args: ["./scripts/run-trader-web-local-e2e.mjs"]
  });
}

for (const item of commands) {
  await run(item);
}

console.log("\nMVP verification completed.");

function readBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  return value === "1" || value === "true";
}

function run(item) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${item.label}`);
    const child = spawn(item.command, item.args, {
      stdio: "inherit",
      env: process.env
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${item.label} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`
        )
      );
    });
    child.on("error", reject);
  });
}
