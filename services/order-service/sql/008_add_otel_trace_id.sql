-- M3-1: keep the OpenTelemetry trace id of the request that created the order,
-- so UIs can deep-link into Jaeger. trace_id stays the business trace key.
alter table spot_orders add column if not exists otel_trace_id text;
