import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { LOCAL_INTERNAL_SERVICE_AUTH_SECRET } from "./internal-service-auth.mjs";

export const rootDir = process.cwd();
export const runtimeRoot = path.join(rootDir, ".runtime", "full-stack");
export const runtimeLogsDir = path.join(runtimeRoot, "logs");
export const runtimePidsDir = path.join(runtimeRoot, "pids");
export const runtimeStateFile = path.join(runtimeRoot, "state.json");
export const composeFile = path.join(rootDir, "infra", "local", "docker-compose.yml");
export const observabilityComposeProfile = "observability";
export const defaultOtlpEndpoint = "http://127.0.0.1:4318";
// Preloads OpenTelemetry before the service's ESM graph is loaded. It is a no-op
// unless OTEL_ENABLED=true (see `--observability` in start-all-services.mjs).
const telemetryPreloadArgs = ["--import", "@web3-cex/telemetry/register"];
const internalCallerServiceIds = new Set([
  "api-gateway",
  "blockchain-indexer",
  "custody-adapter",
  "identity-service",
  "ledger-service",
  "market-data-service",
  "ops-console",
  "order-service",
  "risk-service",
  "settlement-service",
  "wallet-service"
]);
const internalBindServiceIds = new Set([
  "blockchain-indexer",
  "custody-adapter",
  "identity-service",
  "ledger-service",
  "order-service",
  "risk-service",
  "settlement-service",
  "wallet-service"
]);

export const serviceDefinitions = [
  {
    id: "matching-engine",
    label: "matching-engine",
    cwd: rootDir,
    command: "cargo",
    args: ["run", "--manifest-path", "./engines/matching-engine/Cargo.toml"],
    port: 3011
  },
  {
    id: "identity-service",
    label: "identity-service",
    cwd: path.join(rootDir, "services", "identity-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3005
  },
  {
    id: "ledger-service",
    label: "ledger-service",
    cwd: path.join(rootDir, "services", "ledger-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3001
  },
  {
    // Background worker (no port): publishes ledger outbox events to Kafka.
    id: "ledger-outbox-publisher",
    label: "ledger-outbox-publisher",
    cwd: path.join(rootDir, "services", "ledger-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/scripts/publish-outbox.js"],
    port: null,
    env: {
      LEDGER_OUTBOX_RUN_FOREVER: "true"
    }
  },
  {
    id: "wallet-service",
    label: "wallet-service",
    cwd: path.join(rootDir, "services", "wallet-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3002,
    env: {
      // M5-2: production semantics lock withdrawals for 24h after a security
      // change; the demo stack disables it unless you export e.g. 120.
      WITHDRAWAL_SECURITY_COOLDOWN_SECONDS: process.env.WITHDRAWAL_SECURITY_COOLDOWN_SECONDS ?? "0"
    }
  },
  {
    id: "blockchain-indexer",
    label: "blockchain-indexer",
    cwd: path.join(rootDir, "services", "blockchain-indexer"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3003
  },
  {
    id: "custody-adapter",
    label: "custody-adapter",
    cwd: path.join(rootDir, "services", "custody-adapter"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3004
  },
  {
    id: "risk-service",
    label: "risk-service",
    cwd: path.join(rootDir, "services", "risk-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3008
  },
  {
    id: "settlement-service",
    label: "settlement-service",
    cwd: path.join(rootDir, "services", "settlement-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3010
  },
  {
    id: "order-service",
    label: "order-service",
    cwd: path.join(rootDir, "services", "order-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3009
  },
  {
    id: "market-data-service",
    label: "market-data-service",
    cwd: path.join(rootDir, "services", "market-data-service"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3012
  },
  {
    id: "api-gateway",
    label: "api-gateway",
    cwd: path.join(rootDir, "services", "api-gateway"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3007
  },
  {
    id: "demo-simulator",
    label: "demo-simulator",
    cwd: rootDir,
    command: "node",
    args: ["./scripts/demo-simulator.mjs"],
    port: 3014
  },
  {
    id: "ops-console",
    label: "ops-console",
    cwd: path.join(rootDir, "apps", "ops-console"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3006
  },
  {
    id: "trader-web",
    label: "trader-web",
    cwd: path.join(rootDir, "apps", "trader-web"),
    command: "node",
    args: [...telemetryPreloadArgs, "./dist/main.js"],
    port: 3013
  }
].map((definition) => ({
  ...definition,
  tracing: definition.args.includes("@web3-cex/telemetry/register"),
  env: {
    ...(definition.env ?? {}),
    ...(definition.args.includes("@web3-cex/telemetry/register")
      ? { OTEL_SERVICE_NAME: definition.id }
      : {}),
    ...(internalCallerServiceIds.has(definition.id)
      ? {
          INTERNAL_SERVICE_AUTH_SECRET: LOCAL_INTERNAL_SERVICE_AUTH_SECRET,
          INTERNAL_SERVICE_CALLER_NAME: definition.id
        }
      : {}),
    ...(internalBindServiceIds.has(definition.id)
      ? {
          INTERNAL_SERVICE_BIND_HOST: process.env.INTERNAL_SERVICE_BIND_HOST ?? "127.0.0.1"
        }
      : {})
  }
}));

/** Enables OpenTelemetry export (to Jaeger) for every service that preloads the telemetry package. */
export function withObservabilityEnv(definitions) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? defaultOtlpEndpoint;

  return definitions.map((definition) =>
    definition.tracing
      ? {
          ...definition,
          env: {
            ...definition.env,
            OTEL_ENABLED: "true",
            OTEL_SERVICE_NAME: definition.id,
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint
          }
        }
      : definition
  );
}

export async function ensureRuntimeDirs() {
  await mkdir(runtimeLogsDir, { recursive: true });
  await mkdir(runtimePidsDir, { recursive: true });
}

export async function runForeground(command, args, options = {}) {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  console.log(`\n==> ${label}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`
        )
      );
    });
  });
}

export async function startManagedService(definition) {
  await ensureRuntimeDirs();

  const logPath = logFilePath(definition.id);
  await appendFile(
    logPath,
    `\n[${new Date().toISOString()}] starting ${definition.label}: ${definition.command} ${definition.args.join(" ")}\n`
  );

  const logFd = openSync(logPath, "a");

  try {
    const child = spawn(definition.command, definition.args, {
      cwd: definition.cwd,
      env: { ...process.env, ...(definition.env ?? {}) },
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    if (!child.pid) {
      throw new Error(`Unable to capture pid for ${definition.label}`);
    }

    await writeFile(pidFilePath(definition.id), `${child.pid}\n`, "utf8");
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

export async function stopManagedServices(definitions, options = {}) {
  const results = [];

  for (const definition of definitions) {
    const result = await stopManagedService(definition, options);
    results.push(result);
  }

  return results;
}

export async function stopManagedService(definition, options = {}) {
  const pid = await readPid(definition.id);
  const graceMs = options.graceMs ?? 5000;

  if (!pid) {
    return { id: definition.id, status: "missing" };
  }

  if (!isPidAlive(pid)) {
    await clearPid(definition.id);
    return { id: definition.id, status: "stale", pid };
  }

  process.kill(pid, "SIGTERM");
  const stoppedGracefully = await waitForProcessExit(pid, graceMs);

  if (!stoppedGracefully && isPidAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid, 2000);
  }

  const status = isPidAlive(pid) ? "still-running" : "stopped";
  await clearPid(definition.id);
  return { id: definition.id, status, pid };
}

export async function readPid(id) {
  try {
    const content = await readFile(pidFilePath(id), "utf8");
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function clearPid(id) {
  try {
    await unlink(pidFilePath(id));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Readiness: wait for the port, or for a port-less worker to stay alive briefly. */
export async function waitForServiceReady(definition, pid, options = {}) {
  if (definition.port) {
    return waitForPort(definition.port, options);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return isPidAlive(pid);
}

export async function waitForPort(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 250;
  const host = options.host ?? "127.0.0.1";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (await isPortOpen(port, host)) {
      return true;
    }

    await delay(intervalMs);
  }

  return false;
}

export async function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });

    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function cleanupStalePidFiles() {
  for (const definition of serviceDefinitions) {
    const pid = await readPid(definition.id);

    if (pid && !isPidAlive(pid)) {
      await clearPid(definition.id);
    }
  }
}

export async function readStackState() {
  try {
    const content = await readFile(runtimeStateFile, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeStackState(state) {
  await ensureRuntimeDirs();
  await writeFile(runtimeStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearStackState() {
  try {
    await rm(runtimeStateFile, { force: true });
  } catch {
    // noop
  }
}

export function pidFilePath(id) {
  return path.join(runtimePidsDir, `${id}.pid`);
}

export function logFilePath(id) {
  return path.join(runtimeLogsDir, `${id}.log`);
}

export function formatCommand(definition) {
  return `${definition.command} ${definition.args.join(" ")}`;
}

export function summarizeService(definition, status) {
  const pidLabel = status.pid ? `pid=${status.pid}` : "pid=-";
  return `${definition.id.padEnd(20)} ${status.state.padEnd(18)} ${pidLabel.padEnd(12)} port=${definition.port} log=${logFilePath(definition.id)}`;
}

export async function collectServiceStatuses() {
  await cleanupStalePidFiles();
  const statuses = [];

  for (const definition of serviceDefinitions) {
    const pid = await readPid(definition.id);
    const pidAlive = pid ? isPidAlive(pid) : false;
    // Port-less workers are "running" whenever their process is alive.
    const portOpen = definition.port ? await isPortOpen(definition.port) : pidAlive;
    let state = "stopped";

    if (pidAlive && portOpen) {
      state = "running";
    } else if (pidAlive) {
      state = "starting";
    } else if (portOpen) {
      state = "port-in-use";
    }

    statuses.push({
      ...definition,
      pid: pidAlive ? pid : null,
      portOpen,
      state
    });
  }

  return statuses;
}

export async function ensureNoPortConflicts() {
  const statuses = await collectServiceStatuses();
  const conflicts = statuses.filter((status) => status.state !== "stopped");

  if (conflicts.length === 0) {
    return;
  }

  const message = conflicts
    .map((status) => `- ${status.id}: ${status.state}${status.pid ? ` (pid ${status.pid})` : ""}, port ${status.port}`)
    .join("\n");

  throw new Error(
    `Detected running services or occupied ports.\n${message}\nRun \`pnpm stack:stop\` or free the ports before starting the full stack again.`
  );
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }

    await delay(200);
  }

  return !isPidAlive(pid);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
