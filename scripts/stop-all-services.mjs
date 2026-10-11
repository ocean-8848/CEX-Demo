import {
  clearStackState,
  composeFile,
  observabilityComposeProfile,
  runForeground,
  serviceDefinitions,
  stopManagedServices
} from "./full-stack-lib.mjs";

const flags = new Set(process.argv.slice(2));
const withInfra = flags.has("--with-infra");

const results = await stopManagedServices([...serviceDefinitions].reverse());

for (const result of results) {
  const pidLabel = result.pid ? ` pid=${result.pid}` : "";
  console.log(`${result.id}: ${result.status}${pidLabel}`);
}

await clearStackState();

if (withInfra) {
  // Naming the profile makes `down` also remove the optional Jaeger container.
  await runForeground(
    "docker",
    ["compose", "-f", composeFile, "--profile", observabilityComposeProfile, "down"],
    {
      label: "stop local infrastructure"
    }
  );
}

console.log("\nManaged full-stack services have been stopped.");
