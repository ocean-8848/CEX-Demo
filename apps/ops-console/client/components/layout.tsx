import { useEffect, type ReactNode } from "react";

import { href, navigate } from "@web3-cex/web-ui";

import type { AlertsReport, Paged, WithdrawalRecord } from "../lib/types.js";
import { useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

export type PageKey =
  | "dashboard"
  | "withdrawals"
  | "users"
  | "deposits"
  | "trading"
  | "markets"
  | "trace"
  | "ledger"
  | "system"
  | "audit";

interface NavItem {
  page: PageKey;
  label: string;
  icon: string;
  permission?: string;
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "概览",
    items: [
      { page: "dashboard", label: "运营总览", icon: "◎", permission: "ops.dashboard.read" },
      { page: "trace", label: "业务追踪", icon: "⌖", permission: "ops.dashboard.read" }
    ]
  },
  {
    title: "业务",
    items: [
      { page: "withdrawals", label: "提现审核", icon: "↑", permission: "ops.withdrawals.read" },
      { page: "deposits", label: "充值与链上", icon: "↓", permission: "ops.deposits.read" },
      { page: "users", label: "用户与资产", icon: "☺", permission: "ops.users.read" },
      { page: "trading", label: "交易与结算", icon: "⇄", permission: "ops.assets.read" },
      { page: "markets", label: "市场管理", icon: "▤", permission: "ops.markets.read" }
    ]
  },
  {
    title: "风控与运维",
    items: [
      { page: "ledger", label: "账本对账", icon: "≡", permission: "ops.ledger.read" },
      { page: "system", label: "系统运维", icon: "⚙", permission: "ops.dashboard.read" },
      { page: "audit", label: "操作审计", icon: "✎", permission: "ops.audit.read" }
    ]
  }
];

export function Shell(props: { page: PageKey; children: ReactNode }) {
  const { session, can, logout, theme, toggleTheme } = useSession();
  const queue = useOpsQuery<Paged<WithdrawalRecord>>(
    can("ops.withdrawals.read") ? "/withdrawals/review-queue?limit=1" : null,
    { refreshMs: 10_000 }
  );
  const alerts = useOpsQuery<AlertsReport>(can("ops.alerts.read") ? "/alerts" : null, { refreshMs: 30_000 });
  const badges: Partial<Record<PageKey, { count: number; tone: string }>> = {
    withdrawals: queue.data?.total ? { count: queue.data.total, tone: "warning" } : undefined,
    system: alerts.data?.alertCount ? { count: alerts.data.alertCount, tone: "negative" } : undefined
  };

  useEffect(() => {
    const label = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.page === props.page)?.label;
    document.title = `${label ? `${label} · ` : ""}Web3 CEX Ops`;
  }, [props.page]);

  return (
    <div className="ops-app">
      <aside className="sidebar">
        <a className="brand" href={href("/")}>
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span className="brand-text">
            <strong>Web3 CEX</strong>
            <span>运营后台</span>
          </span>
        </a>
        <nav>
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((item) => !item.permission || can(item.permission));
            if (items.length === 0) {
              return null;
            }
            return (
              <div className="nav-group" key={group.title}>
                <span className="nav-title">{group.title}</span>
                {items.map((item) => {
                  const badge = badges[item.page];
                  return (
                    <a
                      key={item.page}
                      href={href(item.page === "dashboard" ? "/" : `/${item.page}`)}
                      className={props.page === item.page ? "nav-item active" : "nav-item"}
                      id={`nav-${item.page}`}
                    >
                      <span className="nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="nav-label">{item.label}</span>
                      {badge ? <span className={`nav-badge tone-${badge.tone}`}>{badge.count}</span> : null}
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <a href="http://127.0.0.1:3013" target="_blank" rel="noreferrer" className="muted small">
            打开交易前台 ↗
          </a>
        </div>
      </aside>

      <div className="ops-main">
        <header className="topbar">
          <form
            className="global-search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("q")?.toString().trim();
              if (value) {
                navigate(`/trace?q=${encodeURIComponent(value)}`);
              }
            }}
          >
            <input name="q" placeholder="搜索 userId / orderId / withdrawalId / txHash …" aria-label="业务追踪搜索" />
          </form>
          <div className="topbar-right">
            {alerts.data ? (
              <a href={href("/system")} className={`health-pill tone-${alerts.data.status === "ok" ? "positive" : "negative"}`}>
                <span className="dot" />
                {alerts.data.status === "ok" ? "系统正常" : `${alerts.data.alertCount} 条告警`}
              </a>
            ) : null}
            <button type="button" className="icon-btn" aria-label="切换主题" onClick={toggleTheme}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <div className="operator" id="operator-chip">
              <span className="avatar" aria-hidden="true">
                {(session?.displayName ?? session?.email ?? "O").slice(0, 1).toUpperCase()}
              </span>
              <span className="operator-text">
                <strong>{session?.displayName ?? session?.email}</strong>
                <span>{session?.roles?.join(", ")}</span>
              </span>
              <button type="button" className="link-btn" onClick={() => void logout()} id="logout-button">
                退出
              </button>
            </div>
          </div>
        </header>
        <main className="ops-content">{props.children}</main>
      </div>
      <Toasts />
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useSession();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} {...toast} onClose={() => dismissToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem(props: { tone: "positive" | "negative" | "neutral"; title: string; detail?: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(props.onClose, props.tone === "negative" ? 7000 : 4000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`toast toast-${props.tone}`} role="status">
      <span className="toast-icon" aria-hidden="true">
        {props.tone === "positive" ? "✓" : props.tone === "negative" ? "!" : "i"}
      </span>
      <div className="toast-text">
        <strong>{props.title}</strong>
        {props.detail ? <span>{props.detail}</span> : null}
      </div>
      <button type="button" className="icon-btn" aria-label="关闭" onClick={props.onClose}>
        ✕
      </button>
    </div>
  );
}
