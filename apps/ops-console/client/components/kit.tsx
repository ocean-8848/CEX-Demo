import { useEffect, useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  CopyButton,
  Empty,
  Modal,
  Spinner,
  formatAmount,
  formatDateTime,
  href,
  shortHash,
  type Tone
} from "@web3-cex/web-ui";

const POSITIVE = /^(ok|listed|active|healthy|settled|credited|confirmed|completed|succeeded|filled|approved|closed_circuit|matched|published|delivered)$/;
const NEGATIVE = /^(alert|failed|rejected|dead_lettered|dead|open|frozen|suspended|unhealthy|error|mismatch|cancelled_failed)$/;
const WARNING = /^(halted|pending|pending_trigger|requested|under_review|processing|partially_filled|retrying|recovery_pending|pending_recovery|warning|degraded|confirming|detected|half_open|leased|partial)$/;

const LABELS: Record<string, string> = {
  ok: "正常",
  alert: "告警",
  active: "正常",
  frozen: "已冻结",
  suspended: "已冻结",
  pending: "待处理",
  requested: "待审核",
  under_review: "审核中",
  approved: "已批准",
  rejected: "已拒绝",
  broadcasted: "已广播",
  confirmed: "已确认",
  failed: "失败",
  detected: "已检测",
  confirming: "确认中",
  credited: "已入账",
  accepted: "挂单中",
  partially_filled: "部分成交",
  filled: "完全成交",
  cancelled: "已撤销",
  settled: "已结算",
  pending_recovery: "待恢复",
  completed: "已完成",
  succeeded: "成功",
  partial: "部分成功",
  healthy: "健康",
  unhealthy: "异常",
  closed: "关闭",
  open: "熔断",
  listed: "交易中",
  halted: "已暂停",
  delisted: "已下架",
  pending_trigger: "待触发"
};

export function statusTone(status: string | undefined): Tone {
  const value = (status ?? "").toLowerCase();
  if (POSITIVE.test(value)) {
    return "positive";
  }
  if (NEGATIVE.test(value)) {
    return "negative";
  }
  if (WARNING.test(value)) {
    return "warning";
  }
  return "neutral";
}

export function StatusBadge(props: { status: string | undefined; label?: string }) {
  return (
    <Badge tone={statusTone(props.status)} title={props.status}>
      {props.label ?? LABELS[props.status ?? ""] ?? props.status ?? "--"}
    </Badge>
  );
}

export type TraceKey = "userId" | "accountId" | "orderId" | "tradeId" | "depositId" | "withdrawalId" | "txHash";

/** A shortened id that links to the business trace for that id. */
export function IdLink(props: { id: string | undefined; kind?: TraceKey; head?: number; tail?: number }) {
  if (!props.id) {
    return <span className="muted">--</span>;
  }
  const text = shortHash(props.id, props.head ?? 8, props.tail ?? 4);
  if (!props.kind) {
    return (
      <code className="id" title={props.id}>
        {text}
      </code>
    );
  }
  return (
    <a
      className="id id-link"
      href={href(`/trace?${props.kind}=${encodeURIComponent(props.id)}`)}
      title={`${props.id}\n点击做业务追踪`}
      onClick={(event) => event.stopPropagation()}
    >
      {text}
    </a>
  );
}

export function Amount(props: { value: string | number | undefined; asset?: string; decimals?: number }) {
  return (
    <span className="amount">
      {formatAmount(props.value, props.decimals ?? 8)}
      {props.asset ? <span className="muted"> {props.asset}</span> : null}
    </span>
  );
}

export function Time(props: { value: string | undefined }) {
  return <span className="muted nowrap">{formatDateTime(props.value)}</span>;
}

export function StatCard(props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <>
      <span className="stat-label">{props.label}</span>
      <strong className={`stat-value tone-${props.tone ?? "neutral"}`}>{props.value}</strong>
      {props.hint ? <span className="stat-hint">{props.hint}</span> : null}
    </>
  );
  return props.href ? (
    <a className="stat-card" href={props.href}>
      {body}
    </a>
  ) : (
    <div className="stat-card">{body}</div>
  );
}

export function KeyValue(props: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {props.items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "--"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonView(props: { value: unknown; label?: string; open?: boolean }) {
  return (
    <details className="json-view" open={props.open}>
      <summary>{props.label ?? "原始数据"}</summary>
      <pre>{JSON.stringify(props.value, null, 2)}</pre>
    </details>
  );
}

/** Renders loading / error / empty states around a query result. */
export function QueryView<T>(props: {
  state: { data: T | undefined; error: string | null; loading: boolean; reload: () => void };
  empty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading, reload } = props.state;
  if (error && data === undefined) {
    return (
      <div className="query-error">
        <strong>加载失败</strong>
        <span>{error}</span>
        <Button size="sm" onClick={reload}>
          重试
        </Button>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="query-loading">
        {loading ? <Spinner /> : null} 加载中…
      </div>
    );
  }
  if (props.empty?.(data)) {
    return <Empty title={props.emptyTitle ?? "暂无数据"} hint={props.emptyHint} />;
  }
  return <>{props.children(data)}</>;
}

export function Drawer(props: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);
  if (!props.open) {
    return null;
  }
  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside
        className="drawer"
        style={props.width ? { width: props.width } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="drawer-header">
          <h3>{props.title}</h3>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="drawer-body">{props.children}</div>
      </aside>
    </div>
  );
}

/** Confirmation dialog with an optional free-text note (review note / reject reason). */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  noteLabel?: string;
  noteRequired?: boolean;
  busy?: boolean;
  onConfirm: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (props.open) {
      setNote("");
    }
  }, [props.open]);
  return (
    <Modal open={props.open} title={props.title} onClose={props.onClose}>
      <div className="confirm">
        {props.description ? <div className="confirm-desc">{props.description}</div> : null}
        {props.noteLabel ? (
          <label className="field">
            <span className="field-label">{props.noteLabel}</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder={props.noteRequired ? "必填" : "可选"}
              id="confirm-note"
            />
          </label>
        ) : null}
        <div className="confirm-actions">
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
          <Button
            variant={props.danger ? "sell" : "primary"}
            loading={props.busy}
            disabled={props.noteRequired && !note.trim()}
            onClick={() => props.onConfirm(note.trim())}
            id="confirm-submit"
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function PageHeader(props: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle ? <p className="muted">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
    </div>
  );
}

export function RefreshButton(props: { onClick: () => void; loading?: boolean; updatedAt?: number | null }) {
  return (
    <span className="refresh">
      {props.updatedAt ? <span className="muted small">更新于 {new Date(props.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span> : null}
      <Button size="sm" variant="ghost" onClick={props.onClick} loading={props.loading}>
        刷新
      </Button>
    </span>
  );
}

export function Copyable(props: { value: string | undefined }) {
  if (!props.value) {
    return <span className="muted">--</span>;
  }
  return (
    <span className="copyable">
      <code>{props.value}</code>
      <CopyButton value={props.value} />
    </span>
  );
}

/** Simple offset pager for `{ items, total, limit, offset }` endpoints. */
export function Pager(props: { offset: number; limit: number; total?: number; count: number; onChange: (offset: number) => void }) {
  const hasNext = props.total !== undefined ? props.offset + props.limit < props.total : props.count >= props.limit;
  if (props.offset === 0 && !hasNext) {
    return null;
  }
  return (
    <div className="pager">
      <span className="muted small">
        {props.offset + 1}–{props.offset + props.count}
        {props.total !== undefined ? ` / 共 ${props.total}` : ""}
      </span>
      <Button size="sm" variant="ghost" disabled={props.offset === 0} onClick={() => props.onChange(Math.max(props.offset - props.limit, 0))}>
        上一页
      </Button>
      <Button size="sm" variant="ghost" disabled={!hasNext} onClick={() => props.onChange(props.offset + props.limit)}>
        下一页
      </Button>
    </div>
  );
}
