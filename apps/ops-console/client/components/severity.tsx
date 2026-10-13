import { Badge, type Tone } from "@web3-cex/web-ui";

import type { AlertItem, AlertSeverity } from "../lib/types.js";

const TONE: Record<AlertSeverity, Tone> = { P1: "negative", P2: "warning", P3: "neutral" };

export const SEVERITY_HINT: Record<AlertSeverity, string> = {
  P1: "P1 资金正确性 / 资金出口，立即处理",
  P2: "P2 核心链路受损，尽快响应",
  P3: "P3 非核心，可排队处理"
};

export function SeverityBadge(props: { severity: AlertSeverity | null | undefined }) {
  if (!props.severity) {
    return null;
  }
  return (
    <Badge tone={TONE[props.severity]} title={SEVERITY_HINT[props.severity]}>
      {props.severity}
    </Badge>
  );
}

/** P1 / P2 / P3 counts, zero counts dimmed. */
export function SeverityCounts(props: { counts: Partial<Record<AlertSeverity, number>> | undefined }) {
  return (
    <span className="severity-counts" id="alert-severity-counts">
      {(["P1", "P2", "P3"] as AlertSeverity[]).map((level) => (
        <Badge key={level} tone={props.counts?.[level] ? TONE[level] : "neutral"} title={SEVERITY_HINT[level]}>
          {level} · {props.counts?.[level] ?? 0}
        </Badge>
      ))}
    </span>
  );
}

/** One alert row: level, source, message (rule summary as tooltip). */
export function AlertRow(props: { item: AlertItem; showSource?: boolean }) {
  return (
    <li className={`sev-${props.item.severity}`} title={props.item.summary}>
      <SeverityBadge severity={props.item.severity} />
      {props.showSource ? <span className="alert-source">{props.item.source}</span> : null}
      <span>{props.item.message}</span>
    </li>
  );
}
