import { Badge } from "@web3-cex/web-ui";

/** KYT reason as stored by wallet-service (withdrawal.riskReasons). */
export interface RiskReason {
  code: string;
  score: number;
  message: string;
}

const LEVEL: Record<string, { label: string; tone: "positive" | "warning" | "negative" | "neutral" }> = {
  low: { label: "低风险", tone: "positive" },
  medium: { label: "中风险", tone: "warning" },
  high: { label: "高风险", tone: "negative" },
  blocked: { label: "已拦截", tone: "negative" }
};

export const RISK_LEVEL_OPTIONS = [
  { value: "low", label: "低风险" },
  { value: "medium", label: "中风险" },
  { value: "high", label: "高风险" },
  { value: "blocked", label: "已拦截" }
];

export function RiskBadge(props: { level: string | undefined; score?: number }) {
  if (!props.level) {
    return <span className="muted small">未评估</span>;
  }
  const item = LEVEL[props.level] ?? { label: props.level, tone: "neutral" as const };
  return (
    <Badge tone={item.tone} title={props.score !== undefined ? `风险分 ${props.score}` : undefined}>
      {item.label}
      {props.score !== undefined ? ` · ${props.score}` : ""}
    </Badge>
  );
}

export function RiskReasonList(props: { reasons: RiskReason[] | undefined }) {
  const reasons = props.reasons ?? [];
  if (reasons.length === 0) {
    return <span className="muted">没有命中任何规则</span>;
  }
  return (
    <ul className="risk-list">
      {reasons.map((reason) => (
        <li key={reason.code} className={reason.score > 0 ? "warn" : "ok"}>
          {reason.score > 0 ? `+${reason.score}` : "✓"} {reason.message} <code className="small">{reason.code}</code>
        </li>
      ))}
    </ul>
  );
}
