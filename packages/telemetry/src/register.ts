// Side-effect entry: `node --import @web3-cex/telemetry/register ./dist/main.js`.
//
// It has to be preloaded with `--import` (not imported from main.ts): in ESM the
// whole static import graph of main.js is resolved and loaded before any of its
// modules run, so hooks installed from inside main.ts would come too late to
// wrap `pg`, `redis`, `express` or `@nestjs/core`. A `--import` module is fully
// evaluated (top-level await included) before the entry graph is loaded.
import { isTelemetryEnabled } from "./config.js";

if (isTelemetryEnabled()) {
  const { startTelemetry } = await import("./sdk.js");
  await startTelemetry();
}

export {};
