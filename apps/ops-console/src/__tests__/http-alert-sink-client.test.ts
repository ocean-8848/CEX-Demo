import assert from "node:assert/strict";
import test from "node:test";

import { HttpAlertSinkClient } from "../infrastructure/http-alert-sink-client.js";

test("configured slack and pagerduty sinks are listed with delivery metadata", async () => {
  const client = HttpAlertSinkClient.fromEnvironment({
    OPS_ALERT_SINKS_JSON: JSON.stringify([
      {
        sinkId: "slack-primary",
        name: "Slack Primary",
        deliveryMode: "slack_webhook",
        url: "https://hooks.slack.test/services/1",
        route: "default"
      },
      {
        sinkId: "pd-critical",
        name: "PagerDuty Critical",
        deliveryMode: "pagerduty_events_v2",
        routingKey: "pd-key",
        route: "escalation",
        resolveOnOk: true
      }
    ])
  } as NodeJS.ProcessEnv);

  const sinks = await client.listTradeRuntimeAlertSinks();

  assert.equal(sinks[0]?.deliveryMode, "slack_webhook");
  assert.equal(sinks[1]?.deliveryMode, "pagerduty_events_v2");
  assert.equal(sinks[1]?.route, "escalation");
  assert.equal(sinks[1]?.resolveOnOk, true);
});

test("alert sink client routes repeated escalation payloads to pagerduty and resolve on ok", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new HttpAlertSinkClient(
    [
      {
        sinkId: "slack-primary",
        name: "Slack Primary",
        deliveryMode: "slack_webhook",
        url: "https://hooks.slack.test/services/1",
        route: "default",
        severities: ["warning", "critical"]
      },
      {
        sinkId: "pd-critical",
        name: "PagerDuty Critical",
        deliveryMode: "pagerduty_events_v2",
        url: "https://events.pagerduty.com/v2/enqueue",
        routingKey: "pd-key",
        route: "escalation",
        severities: ["critical"],
        resolveOnOk: true
      }
    ],
    (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });
      return new Response("ok", {
        status: 202
      });
    }) as typeof fetch
  );

  const warningDeliveries = await client.deliverTradeRuntimeAlerts({
    market: "BTC-USDT",
    payload: {
      market: "BTC-USDT",
      maxSeverity: "warning",
      route: "default",
      alerts: [
        {
          code: "TRADE_EVENT_CONSUMER_LAG",
          severity: "warning",
          summary: "lag warning"
        }
      ]
    }
  });

  assert.equal(warningDeliveries.length, 1);
  assert.equal(warningDeliveries[0]?.sinkId, "slack-primary");
  assert.equal(requests[0]?.url, "https://hooks.slack.test/services/1");

  requests.length = 0;

  const criticalDeliveries = await client.deliverTradeRuntimeAlerts({
    market: "BTC-USDT",
    payload: {
      market: "BTC-USDT",
      maxSeverity: "critical",
      route: "escalation",
      alerts: [
        {
          code: "SETTLEMENT_FAILED",
          severity: "critical",
          summary: "critical settlement failure"
        }
      ]
    }
  });

  assert.equal(criticalDeliveries.length, 2);
  assert.equal(
    requests.some((item) => item.url === "https://events.pagerduty.com/v2/enqueue"),
    true
  );
  assert.equal(
    requests.some((item) => item.url === "https://hooks.slack.test/services/1"),
    true
  );

  requests.length = 0;

  const resolvedDeliveries = await client.deliverTradeRuntimeAlerts({
    market: "BTC-USDT",
    payload: {
      market: "BTC-USDT",
      status: "ok",
      maxSeverity: "info",
      route: "escalation",
      alerts: []
    }
  });

  const pagerDutyResolve = requests.find(
    (item) => item.url === "https://events.pagerduty.com/v2/enqueue"
  );
  assert.equal(resolvedDeliveries.length, 2);
  assert.equal(
    (pagerDutyResolve?.body.event_action as string | undefined) === "resolve",
    true
  );
});
