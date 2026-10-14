import process from "node:process";

import {
  clearStackState,
  composeFile,
  ensureNoPortConflicts,
  formatCommand,
  logFilePath,
  observabilityComposeProfile,
  runForeground,
  serviceDefinitions,
  startManagedService,
  stopManagedServices,
  waitForServiceReady,
  withObservabilityEnv,
  writeStackState
} from "./full-stack-lib.mjs";

const flags = new Set(process.argv.slice(2));
const options = {
  skipInfra: flags.has("--skip-infra"),
  skipBuild: flags.has("--skip-build"),
  skipDbPrepare: flags.has("--skip-db-prepare"),
  observability: flags.has("--observability")
};
const definitions = options.observability
  ? withObservabilityEnv(serviceDefinitions)
  : serviceDefinitions;

const started = [];

try {
  await ensureNoPortConflicts();

  if (!options.skipInfra) {
    const profileArgs = options.observability ? ["--profile", observabilityComposeProfile] : [];
    await runForeground("docker", ["compose", "-f", composeFile, ...profileArgs, "up", "-d"], {
      label: options.observability
        ? "start local infrastructure (with Jaeger)"
        : "start local infrastructure"
    });
  }

  if (!options.skipBuild) {
    await runForeground("pnpm", ["build"], { label: "build workspace" });
  }

  if (!options.skipDbPrepare) {
    await runForeground("node", ["./scripts/apply-schema.mjs"], {
      label: "apply pending schema migrations"
    });
  }

  for (const definition of definitions) {
    console.log(`\n==> starting ${definition.label}`);
    console.log(`    ${formatCommand(definition)}`);

    const pid = await startManagedService(definition);
    const ready = await waitForServiceReady(definition, pid, {
      timeoutMs: definition.id === "matching-engine" ? 45000 : 30000
    });

    if (!ready) {
      throw new Error(
        `${definition.label} did not become ready${definition.port ? ` on port ${definition.port}` : ""}. Check ${logFilePath(definition.id)}`
      );
    }

    started.push({ ...definition, pid });
    console.log(`    ready${definition.port ? ` on port ${definition.port}` : ""} (pid ${pid})`);
  }

  await writeStackState({
    startedAt: new Date().toISOString(),
    options,
    services: started.map((item) => ({
      id: item.id,
      pid: item.pid,
      port: item.port,
      logPath: logFilePath(item.id)
    }))
  });

  console.log("\nFull stack is running.");
  console.log("Use `pnpm stack:status` to inspect the managed services.");
  console.log("Use `pnpm stack:stop` to stop all managed services.");
  if (options.observability) {
    console.log("Tracing is on: open Jaeger at http://127.0.0.1:16686 (services export via OTLP).");
  }
} catch (error) {
  if (started.length > 0) {
    console.error("\nStartup failed. Stopping the managed services that were already started.");
    await stopManagedServices([...started].reverse());
    await clearStackState();
  }

  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
