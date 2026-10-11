// Kept dependency-free so `@web3-cex/telemetry/register` stays a cheap no-op
// when tracing is disabled (it never loads the OpenTelemetry SDK).

export const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:4318";

export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.OTEL_ENABLED ?? "").trim().toLowerCase() === "true";
}
