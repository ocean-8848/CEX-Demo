import { collectServiceStatuses, logFilePath, readStackState } from "./full-stack-lib.mjs";

const state = await readStackState();
const statuses = await collectServiceStatuses();

if (state?.startedAt) {
  console.log(`Managed stack started at: ${state.startedAt}`);
}

console.log("");

for (const status of statuses) {
  const pidLabel = status.pid ? `pid=${status.pid}` : "pid=-";
  console.log(
    `${status.id.padEnd(24)} ${status.state.padEnd(12)} ${pidLabel.padEnd(14)} port=${status.port ?? "-"} log=${logFilePath(status.id)}`
  );
}
