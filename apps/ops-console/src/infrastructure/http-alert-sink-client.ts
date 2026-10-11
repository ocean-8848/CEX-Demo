import type { OpsAlertSinkClient } from "../domain/clients.js";

type AlertSeverity = "warning" | "critical";
type AlertSinkDeliveryMode = "http_post" | "slack_webhook" | "pagerduty_events_v2";

interface ConfiguredAlertSink {
  sinkId: string;
  name: string;
  deliveryMode: AlertSinkDeliveryMode;
  url: string;
  token?: string;
  tokenHeader?: string;
  routingKey?: string;
  dedupKeyPrefix?: string;
  route?: "default" | "escalation";
  severities?: AlertSeverity[];
  enabled?: boolean;
  timeoutMs?: number;
  component?: string;
  group?: string;
  resolveOnOk?: boolean;
}

export class HttpAlertSinkClient implements OpsAlertSinkClient {
  constructor(
    private readonly sinks: ConfiguredAlertSink[],
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): HttpAlertSinkClient {
    const configured = parseConfiguredSinks(env.OPS_ALERT_SINKS_JSON);
    return new HttpAlertSinkClient(configured);
  }

  async listTradeRuntimeAlertSinks(): Promise<Record<string, unknown>[]> {
    return this.sinks.map((sink) => ({
      sinkId: sink.sinkId,
      name: sink.name,
      url: sink.url,
      enabled: sink.enabled !== false,
      deliveryMode: sink.deliveryMode,
      route: sink.route ?? "default",
      severities: sink.severities ?? ["warning", "critical"],
      tokenHeader: sink.token ? sink.tokenHeader ?? "authorization" : undefined,
      component: sink.component,
      group: sink.group,
      resolveOnOk: sink.resolveOnOk === true
    }));
  }

  async deliverTradeRuntimeAlerts(command: {
    market: string;
    sinkId?: string;
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]> {
    const alerts = readAlerts(command.payload);
    const maxSeverity = readMaxSeverity(command.payload, alerts);
    const targets = this.sinks.filter((sink) => {
      if (sink.enabled === false) {
        return false;
      }
      if (command.sinkId && sink.sinkId !== command.sinkId) {
        return false;
      }
      return shouldDeliverToSink(sink, maxSeverity, alerts, command.payload);
    });

    const deliveries = [];
    for (const sink of targets) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), sink.timeoutMs ?? 5_000);
      const deliveredAt = new Date().toISOString();

      try {
        const request = buildSinkRequest(sink, {
          market: command.market,
          deliveredAt,
          payload: command.payload,
          alerts,
          maxSeverity
        });
        const response = await this.fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal
        });
        const responseText = await response.text();

        deliveries.push({
          sinkId: sink.sinkId,
          name: sink.name,
          url: sink.url,
          ok: response.ok,
          statusCode: response.status,
          deliveryMode: sink.deliveryMode,
          route: sink.route ?? "default",
          responseText: responseText.slice(0, 500),
          deliveredAt
        });
      } catch (error) {
        deliveries.push({
          sinkId: sink.sinkId,
          name: sink.name,
          url: sink.url,
          ok: false,
          deliveryMode: sink.deliveryMode,
          route: sink.route ?? "default",
          errorMessage: error instanceof Error ? error.message : "unknown alert sink delivery error",
          deliveredAt
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return deliveries;
  }
}

function parseConfiguredSinks(value?: string): ConfiguredAlertSink[] {
  if (!value?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item, index) => normalizeConfiguredSink(item, index))
      .filter((item): item is ConfiguredAlertSink => item !== null);
  } catch {
    return [];
  }
}

function normalizeConfiguredSink(
  value: unknown,
  index: number
): ConfiguredAlertSink | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const sink = value as Record<string, unknown>;
  const deliveryMode = normalizeDeliveryMode(sink.deliveryMode ?? sink.type);
  const url =
    typeof sink.url === "string" && sink.url.trim().length > 0
      ? sink.url.trim()
      : deliveryMode === "pagerduty_events_v2"
        ? "https://events.pagerduty.com/v2/enqueue"
        : "";
  if (!url) {
    return null;
  }

  return {
    sinkId:
      typeof sink.sinkId === "string" && sink.sinkId.trim().length > 0
        ? sink.sinkId.trim()
        : `sink-${index + 1}`,
    name:
      typeof sink.name === "string" && sink.name.trim().length > 0
        ? sink.name.trim()
        : `Alert Sink ${index + 1}`,
    deliveryMode,
    url,
    token: typeof sink.token === "string" && sink.token.trim().length > 0 ? sink.token : undefined,
    tokenHeader:
      typeof sink.tokenHeader === "string" && sink.tokenHeader.trim().length > 0
        ? sink.tokenHeader.trim()
        : undefined,
    routingKey:
      typeof sink.routingKey === "string" && sink.routingKey.trim().length > 0
        ? sink.routingKey.trim()
        : undefined,
    dedupKeyPrefix:
      typeof sink.dedupKeyPrefix === "string" && sink.dedupKeyPrefix.trim().length > 0
        ? sink.dedupKeyPrefix.trim()
        : undefined,
    route: sink.route === "escalation" ? "escalation" : "default",
    severities: normalizeSeverities(sink.severities, sink.minimumSeverity),
    enabled: typeof sink.enabled === "boolean" ? sink.enabled : true,
    timeoutMs:
      typeof sink.timeoutMs === "number" && Number.isFinite(sink.timeoutMs)
        ? Math.max(Math.trunc(sink.timeoutMs), 1_000)
        : undefined,
    component:
      typeof sink.component === "string" && sink.component.trim().length > 0
        ? sink.component.trim()
        : undefined,
    group:
      typeof sink.group === "string" && sink.group.trim().length > 0
        ? sink.group.trim()
        : undefined,
    resolveOnOk: sink.resolveOnOk === true
  };
}

function normalizeDeliveryMode(value: unknown): AlertSinkDeliveryMode {
  if (value === "slack_webhook" || value === "pagerduty_events_v2") {
    return value;
  }

  return "http_post";
}

function normalizeSeverities(
  value: unknown,
  minimumSeverity: unknown
): AlertSeverity[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.filter(
      (item): item is AlertSeverity => item === "warning" || item === "critical"
    );
    return normalized.length > 0 ? normalized : undefined;
  }

  if (minimumSeverity === "critical") {
    return ["critical"];
  }

  if (minimumSeverity === "warning") {
    return ["warning", "critical"];
  }

  return undefined;
}

function readAlerts(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(payload.alerts)) {
    return [];
  }

  return payload.alerts.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
  );
}

function readMaxSeverity(
  payload: Record<string, unknown>,
  alerts: Array<Record<string, unknown>>
): AlertSeverity | "info" {
  if (payload.maxSeverity === "critical" || payload.maxSeverity === "warning") {
    return payload.maxSeverity;
  }

  return alerts.some((item) => item.severity === "critical")
    ? "critical"
    : alerts.length > 0
      ? "warning"
      : "info";
}

function shouldDeliverToSink(
  sink: ConfiguredAlertSink,
  maxSeverity: AlertSeverity | "info",
  alerts: Array<Record<string, unknown>>,
  payload: Record<string, unknown>
): boolean {
  const requestedRoute = payload.route === "escalation" ? "escalation" : "default";
  const severities = sink.severities ?? ["warning", "critical"];
  if (maxSeverity === "info") {
    if (sink.deliveryMode === "pagerduty_events_v2" && sink.resolveOnOk) {
      return sink.route === requestedRoute || sink.route !== "escalation";
    }
    return sink.route !== "escalation";
  }

  if (!severities.includes(maxSeverity)) {
    return alerts.some((item) => {
      const severity = item.severity;
      return (severity === "warning" || severity === "critical") && severities.includes(severity);
    });
  }

  if (sink.route === "escalation" && requestedRoute !== "escalation") {
    return false;
  }

  return true;
}

function buildSinkRequest(
  sink: ConfiguredAlertSink,
  context: {
    market: string;
    deliveredAt: string;
    payload: Record<string, unknown>;
    alerts: Array<Record<string, unknown>>;
    maxSeverity: AlertSeverity | "info";
  }
): {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
} {
  switch (sink.deliveryMode) {
    case "slack_webhook":
      return buildSlackRequest(sink, context);
    case "pagerduty_events_v2":
      return buildPagerDutyRequest(sink, context);
    default:
      return buildHttpRequest(sink, context);
  }
}

function buildHttpRequest(
  sink: ConfiguredAlertSink,
  context: {
    market: string;
    deliveredAt: string;
    payload: Record<string, unknown>;
  }
) {
  const headers = new Headers({
    "content-type": "application/json"
  });
  if (sink.token) {
    headers.set(sink.tokenHeader ?? "authorization", sink.token);
  }

  return {
    url: sink.url,
    headers,
    body: {
      source: "trade_runtime",
      deliveryMode: sink.deliveryMode,
      route: sink.route ?? "default",
      market: context.market,
      deliveredAt: context.deliveredAt,
      payload: context.payload
    }
  };
}

function buildSlackRequest(
  sink: ConfiguredAlertSink,
  context: {
    market: string;
    deliveredAt: string;
    payload: Record<string, unknown>;
    alerts: Array<Record<string, unknown>>;
    maxSeverity: AlertSeverity | "info";
  }
) {
  const headers = new Headers({
    "content-type": "application/json"
  });
  if (sink.token) {
    headers.set(sink.tokenHeader ?? "authorization", sink.token);
  }

  const lines =
    context.alerts.length > 0
      ? context.alerts
          .slice(0, 10)
          .map((item) => `• [${String(item.severity ?? "warning").toUpperCase()}] ${String(item.summary ?? "")}`)
      : ["• no active alerts"];

  return {
    url: sink.url,
    headers,
    body: {
      text: `[${String(context.maxSeverity).toUpperCase()}] trade runtime ${context.market}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Trade runtime ${context.market}*\nSeverity: *${String(context.maxSeverity).toUpperCase()}*\nRoute: *${sink.route ?? "default"}*`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: lines.join("\n")
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `deliveredAt=${context.deliveredAt}`
            }
          ]
        }
      ],
      metadata: {
        market: context.market,
        payload: context.payload
      }
    }
  };
}

function buildPagerDutyRequest(
  sink: ConfiguredAlertSink,
  context: {
    market: string;
    deliveredAt: string;
    payload: Record<string, unknown>;
    alerts: Array<Record<string, unknown>>;
    maxSeverity: AlertSeverity | "info";
  }
) {
  const headers = new Headers({
    "content-type": "application/json"
  });
  if (sink.token) {
    headers.set(sink.tokenHeader ?? "authorization", sink.token);
  }

  const severity = context.maxSeverity === "info" ? "info" : context.maxSeverity;
  const summary =
    context.alerts[0]?.summary ??
    `trade runtime ${context.market} status=${String(context.payload.status ?? "ok")}`;
  const eventAction =
    context.maxSeverity === "info" && sink.resolveOnOk ? "resolve" : "trigger";

  return {
    url: sink.url,
    headers,
    body: {
      routing_key: sink.routingKey ?? sink.token ?? "",
      event_action: eventAction,
      dedup_key: `${sink.dedupKeyPrefix ?? "trade-runtime"}:${context.market}`,
      payload: {
        summary,
        source: "web3-cex/ops-console",
        severity,
        timestamp: context.deliveredAt,
        component: sink.component ?? "trade-runtime",
        group: sink.group ?? "spot-trading",
        custom_details: {
          market: context.market,
          alertCount: context.alerts.length,
          alerts: context.alerts,
          payload: context.payload
        }
      }
    }
  };
}
