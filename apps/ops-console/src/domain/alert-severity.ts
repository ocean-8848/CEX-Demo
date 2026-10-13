/**
 * Alert levels (A3). Every alert the ops console shows gets one of:
 *
 * - P1 资金正确性 / 资金出口：账实不一致、负余额、对账熔断触发。立即处理。
 * - P2 核心链路受损：结算失败或严重滞后、托管熔断、outbox 死信、长时间冻结、
 *      链上观察积压 / 重组、紧急开关处于开启状态、对账可疑或对账任务失败。15 分钟内响应（示例）。
 * - P3 非核心 / 可排队处理：通知积压、审核队列偏长、outbox 堆积、事件流保留压力等。工作时间处理。
 *
 * The rules are keyed by the metric name of the upstream alert string
 * (`balance_mismatch_count=3 exceeds threshold 0` → `balance_mismatch_count`)
 * or by a code (`SETTLEMENT_FAILED`). Unknown alerts default to P2 so nothing
 * new is silently filed as low priority. docs/security.md lists the same table.
 */
export type AlertSeverity = "P1" | "P2" | "P3";

export const ALERT_SEVERITIES: AlertSeverity[] = ["P1", "P2", "P3"];

export interface AlertSeverityRule {
  source: string;
  /** Metric name or code, as emitted upstream. */
  key: string;
  severity: AlertSeverity;
  summary: string;
}

export const ALERT_SEVERITY_RULES: AlertSeverityRule[] = [
  // ledger-service check-alerts / ops overview
  { source: "ledger", key: "balance_mismatch_count", severity: "P1", summary: "余额快照与分录净额 / 冻结不一致" },
  { source: "ledger", key: "negative_available_balance_count", severity: "P1", summary: "出现负可用余额" },
  { source: "ledger", key: "negative_locked_balance_count", severity: "P1", summary: "出现负冻结余额" },
  { source: "ledger", key: "dead_lettered_outbox_count", severity: "P2", summary: "账本事件进入死信" },
  { source: "ledger", key: "stale_locked_balance_count", severity: "P2", summary: "冻结长时间未释放" },
  { source: "ledger", key: "pending_outbox_count", severity: "P3", summary: "账本 outbox 待发布堆积" },
  { source: "ledger", key: "retrying_outbox_count", severity: "P3", summary: "账本 outbox 重试中" },
  { source: "ledger", key: "oldest_pending_outbox_age_seconds", severity: "P3", summary: "最老的 outbox 事件等待过久" },
  // reconciliation job + circuit breaker (ledger-service)
  { source: "reconciliation", key: "RECONCILIATION_BREAKER_TRIPPED", severity: "P1", summary: "对账熔断已自动暂停该币种提现" },
  { source: "reconciliation", key: "RECONCILIATION_BREAKER_FAILED", severity: "P1", summary: "对账不平但熔断未能暂停提现" },
  { source: "reconciliation", key: "BALANCE_RECONCILIATION_MISMATCH", severity: "P1", summary: "定时余额对账不平" },
  { source: "reconciliation", key: "ORDER_LOCK_MISMATCH_CONFIRMED", severity: "P1", summary: "委托冻结与账本冻结连续多轮不一致" },
  { source: "reconciliation", key: "ORDER_LOCK_MISMATCH_SUSPECTED", severity: "P2", summary: "委托冻结与账本冻结首次不一致（待确认）" },
  { source: "reconciliation", key: "ORDER_LOCK_RECONCILIATION_UNAVAILABLE", severity: "P2", summary: "委托冻结对账无法完成（order-service 不可用）" },
  { source: "reconciliation", key: "RECONCILIATION_FAILED", severity: "P2", summary: "对账任务失败（按未知处理）" },
  { source: "reconciliation", key: "RECONCILIATION_STALE", severity: "P2", summary: "定时对账长时间没有新结果" },
  // emergency switches (risk-service)
  { source: "controls", key: "withdrawals_paused", severity: "P2", summary: "全站提现已暂停" },
  { source: "controls", key: "asset_withdrawals_paused", severity: "P2", summary: "单币种提现已暂停（人工）" },
  { source: "controls", key: "api_write_frozen", severity: "P2", summary: "API 写入已冻结（只读模式）" },
  // custody-adapter
  { source: "custody", key: "open_circuit_count", severity: "P2", summary: "托管通道熔断" },
  { source: "custody", key: "unhealthy_route_count", severity: "P2", summary: "托管通道不健康" },
  { source: "custody", key: "failed_count", severity: "P2", summary: "托管广播失败" },
  { source: "custody", key: "retryable_count", severity: "P3", summary: "托管广播待重试" },
  { source: "custody", key: "pending_sync_count", severity: "P3", summary: "托管状态待回查" },
  { source: "custody", key: "oldest_pending_sync_age_seconds", severity: "P3", summary: "托管回查等待过久" },
  // blockchain-indexer
  { source: "indexer", key: "reorg_cursor_count", severity: "P2", summary: "检测到链重组" },
  { source: "indexer", key: "pending_withdrawal_count", severity: "P2", summary: "提现链上确认积压" },
  { source: "indexer", key: "oldest_pending_withdrawal_age_seconds", severity: "P2", summary: "提现确认等待过久" },
  { source: "indexer", key: "pending_deposit_count", severity: "P3", summary: "充值确认积压" },
  { source: "indexer", key: "oldest_pending_deposit_age_seconds", severity: "P3", summary: "充值确认等待过久" },
  { source: "indexer", key: "deposit_cursor_lag_blocks", severity: "P3", summary: "充值扫描落后" },
  { source: "indexer", key: "withdrawal_cursor_lag_blocks", severity: "P2", summary: "提现扫描落后" },
  { source: "indexer", key: "deposit_cursor_age_seconds", severity: "P3", summary: "充值扫描游标停滞" },
  { source: "indexer", key: "withdrawal_cursor_age_seconds", severity: "P2", summary: "提现扫描游标停滞" },
  // wallet-service (computed in ops-console)
  { source: "wallet", key: "failed_notifications", severity: "P3", summary: "站内信投递失败" },
  { source: "wallet", key: "pending_notifications", severity: "P3", summary: "站内信待投递堆积" },
  { source: "wallet", key: "review_queue", severity: "P3", summary: "提现审核队列偏长" },
  // trading domain (settlement report + settlement consumer)
  { source: "trading", key: "settlement_failed_count", severity: "P2", summary: "存在结算失败的成交" },
  { source: "trading", key: "settlement_pending_recovery_count", severity: "P3", summary: "成交结算待恢复" },
  { source: "trading", key: "settlement_lag_critical", severity: "P2", summary: "结算严重滞后（已成交未结算）" },
  { source: "trading", key: "settlement_lag", severity: "P3", summary: "结算滞后" },
  { source: "trading", key: "settlement_consumer_paused", severity: "P2", summary: "结算消费者已暂停" },
  // trade runtime alerts (系统运维 → 事件总线 / 告警投递)
  { source: "trade_runtime", key: "SETTLEMENT_FAILED", severity: "P2", summary: "结算失败" },
  { source: "trade_runtime", key: "TRADE_EVENT_CONSUMER_LAG", severity: "P2", summary: "结算消费滞后" },
  { source: "trade_runtime", key: "TRADE_EVENT_PROTOCOL_V2_UNSUPPORTED", severity: "P2", summary: "事件协议版本不兼容" },
  { source: "trade_runtime", key: "ORDER_DEAD_LETTER_BACKLOG", severity: "P2", summary: "订单恢复死信积压" },
  { source: "trade_runtime", key: "SETTLEMENT_PENDING_RECOVERY", severity: "P3", summary: "结算待恢复" },
  { source: "trade_runtime", key: "ORDER_RECOVERY_EXPIRED_LEASE", severity: "P3", summary: "订单恢复租约过期" },
  { source: "trade_runtime", key: "SETTLEMENT_RECOVERY_EXPIRED_LEASE", severity: "P3", summary: "结算恢复租约过期" },
  { source: "trade_runtime", key: "TRADE_EVENT_STREAM_RETENTION_PRESSURE", severity: "P3", summary: "事件流保留压力" },
  { source: "trade_runtime", key: "TRADE_RUNTIME_SCHEDULE_DUE", severity: "P3", summary: "运维计划到期" },
  { source: "trade_runtime", key: "TRADE_RUNTIME_EXECUTION_DIFF", severity: "P3", summary: "作业执行结果变化" }
];

const RULES_BY_KEY = new Map(ALERT_SEVERITY_RULES.map((rule) => [`${rule.source}:${rule.key}`, rule]));

/** `deposit_cursor_lag_blocks:ethereum=12 exceeds threshold 5` → `deposit_cursor_lag_blocks`. */
export function alertMetricKey(message: string): string {
  const head = message.split("=")[0] ?? message;
  return (head.split(":")[0] ?? head).trim();
}

export interface ClassifiedAlert {
  source: string;
  code: string;
  severity: AlertSeverity;
  message: string;
  summary?: string;
}

export function classifyAlert(source: string, messageOrCode: string, explicitCode?: string): ClassifiedAlert {
  const code = explicitCode ?? alertMetricKey(messageOrCode);
  const rule = RULES_BY_KEY.get(`${source}:${code}`);
  return {
    source,
    code,
    severity: rule?.severity ?? "P2",
    message: messageOrCode,
    summary: rule?.summary
  };
}

/** Trade runtime alerts carry `warning` / `critical`; map them by code (critical never below P2). */
export function tradeRuntimeAlertLevel(code: string, severity: "warning" | "critical" | string): AlertSeverity {
  const rule = RULES_BY_KEY.get(`trade_runtime:${code}`);
  const level = rule?.severity ?? (severity === "critical" ? "P2" : "P3");
  return severity === "critical" && level === "P3" ? "P2" : level;
}

export function severityRank(severity: AlertSeverity): number {
  return severity === "P1" ? 1 : severity === "P2" ? 2 : 3;
}

/** Sorted P1 → P3 (stable within a level), with counts per level. */
export function summarizeAlerts(items: ClassifiedAlert[]): {
  items: ClassifiedAlert[];
  countsBySeverity: Record<AlertSeverity, number>;
  highestSeverity: AlertSeverity | null;
} {
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => severityRank(left.item.severity) - severityRank(right.item.severity) || left.index - right.index)
    .map(({ item }) => item);
  const countsBySeverity: Record<AlertSeverity, number> = { P1: 0, P2: 0, P3: 0 };
  for (const item of sorted) {
    countsBySeverity[item.severity] += 1;
  }
  return { items: sorted, countsBySeverity, highestSeverity: sorted[0]?.severity ?? null };
}
