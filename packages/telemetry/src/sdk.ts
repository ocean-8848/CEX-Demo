import * as nodeModule from "node:module";

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation, ExpressLayerType } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  register as registerSyncImportHooks,
  supportsSyncHooks
} from "import-in-the-middle/register-hooks.mjs";

import { DEFAULT_OTLP_ENDPOINT } from "./config.js";

/**
 * Packages whose ESM imports must be wrapped by import-in-the-middle so the
 * instrumentations below can patch them. CommonJS `require()` calls made by
 * these libraries internally are covered by require-in-the-middle.
 */
const ESM_HOOKED_MODULES = [
  "http",
  "https",
  "node:http",
  "node:https",
  "express",
  "@nestjs/core",
  "pg",
  "pg-pool",
  "redis",
  "@redis/client"
];

let sdk: NodeSDK | undefined;

export async function startTelemetry(): Promise<void> {
  if (sdk) {
    return;
  }

  if (process.env.OTEL_LOG_LEVEL?.toLowerCase() === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  // The demo only exports traces; keep the SDK from wiring metric / log exporters.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = DEFAULT_OTLP_ENDPOINT;
  }

  installEsmImportHooks();

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "web3-cex-node",
    // Reads OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT and appends /v1/traces.
    traceExporter: new OTLPTraceExporter(),
    // Explicit allow-list instead of auto-instrumentations-node: noisy ones
    // (fs, dns, net) and everything the services do not use are never loaded.
    instrumentations: [
      new HttpInstrumentation({
        // Background pollers would otherwise create one root trace per tick.
        requireParentforOutgoingSpans: true
      }),
      new ExpressInstrumentation({
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE]
      }),
      new NestInstrumentation(),
      new UndiciInstrumentation({
        requireParentforSpans: true
      }),
      new PgInstrumentation({
        requireParentSpan: true
      }),
      new RedisInstrumentation({
        requireParentSpan: true
      })
    ]
  });

  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

function installEsmImportHooks(): void {
  if (supportsSyncHooks()) {
    // In-thread `module.registerHooks()` (Node >= 22.22.3 / 24.11.1 / 26).
    registerSyncImportHooks({ include: ESM_HOOKED_MODULES });
    return;
  }

  // Older Node: off-thread loader. `register` is looked up dynamically so the
  // package still type-checks against @types/node versions that mark it deprecated.
  const register = (nodeModule as { register?: (...args: unknown[]) => void }).register;
  register?.("import-in-the-middle/hook.mjs", import.meta.url, {
    data: { include: ESM_HOOKED_MODULES }
  });
}
