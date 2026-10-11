import {
  context,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span
} from "@opentelemetry/api";

export { isTelemetryEnabled } from "./config.js";
export { SpanKind, type Attributes, type Span };

const TRACER_NAME = "@web3-cex/telemetry";

/** W3C trace-context fields, e.g. `{ traceparent: "00-<traceId>-<spanId>-01" }`. */
export type TraceCarrier = Record<string, string>;

export interface WithSpanOptions {
  kind?: SpanKind;
  /** Parent context; defaults to the active context. */
  parent?: Context;
  links?: Link[];
}

/** Trace id of the active span, or undefined when tracing is off / no span is active. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

/**
 * Runs `fn` inside a new active span. Errors are recorded on the span and rethrown.
 * Without an SDK registered (OTEL_ENABLED unset) this is a no-op wrapper.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
  options: WithSpanOptions = {}
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes, links: options.links },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error)
        });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/** Serializes the active trace context (empty object when tracing is off). */
export function injectTraceContext(ctx: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(ctx, carrier);
  return carrier;
}

/** Rebuilds a context from a carrier previously produced by `injectTraceContext`. */
export function extractTraceContext(carrier: Partial<TraceCarrier> | undefined): Context {
  const clean: TraceCarrier = {};
  for (const [key, value] of Object.entries(carrier ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      clean[key] = value;
    }
  }
  return propagation.extract(ROOT_CONTEXT, clean);
}

/** Span link pointing at the span encoded in `carrier`, if any. */
export function linkFromTraceContext(carrier: Partial<TraceCarrier> | undefined): Link[] {
  const spanContext = trace.getSpanContext(extractTraceContext(carrier));
  return spanContext && isSpanContextValid(spanContext) ? [{ context: spanContext }] : [];
}
