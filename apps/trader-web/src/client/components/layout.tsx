import { useEffect, useRef, useState } from "react";

import { Button, FeedDot } from "@web3-cex/web-ui";

import { href, navigate, type PageKey } from "../lib/router.js";
import { useExchange } from "../state/store.js";
import { NotificationBell } from "./notification-bell.js";

const NAV: Array<{ page: PageKey; label: string; path: string; private?: boolean }> = [
  { page: "home", label: "首页", path: "/" },
  { page: "trade", label: "交易", path: "/trade" },
  { page: "assets", label: "资产", path: "/assets", private: true },
  { page: "orders", label: "订单", path: "/orders", private: true },
  { page: "account", label: "账户", path: "/account", private: true }
];

export function TopNav(props: { page: PageKey }) {
  const { state, actions } = useExchange();
  const loggedIn = Boolean(state.token);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return (
    <header className="topnav">
      <a className="brand" href={href("/")}>
        <span className="brand-mark" aria-hidden="true">
          ◆
        </span>
        <span className="brand-name">{state.config?.appTitle ?? "Web3 CEX"}</span>
        <span className="brand-tag">Learning Demo</span>
      </a>

      <nav className="nav-links">
        {NAV.filter((item) => loggedIn || !item.private).map((item) => (
          <a
            key={item.page}
            href={href(item.page === "trade" ? `/trade/${state.market}` : item.path)}
            className={props.page === item.page ? "nav-link active" : "nav-link"}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="nav-right">
        <div className="feeds">
          <FeedDot status={state.publicFeed} label="行情" id="public-feed-status" />
          {loggedIn ? <FeedDot status={state.privateFeed} label="账户" id="private-feed-status" /> : null}
        </div>
        <button
          type="button"
          className={state.prefs.learnMode ? "learn-toggle on" : "learn-toggle"}
          onClick={() => actions.setPrefs({ learnMode: !state.prefs.learnMode })}
          title="打开后会实时展示每个操作背后经过了哪些服务"
          id="learn-toggle"
        >
          <span aria-hidden="true">🎓</span> 学习模式
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="切换主题"
          title="切换深色 / 浅色"
          onClick={() => actions.setPrefs({ theme: state.prefs.theme === "dark" ? "light" : "dark" })}
        >
          {state.prefs.theme === "dark" ? "☀" : "☾"}
        </button>
        {loggedIn ? <NotificationBell /> : null}
        {loggedIn ? (
          <div className="user-menu" ref={menuRef}>
            <button
              type="button"
              className="user-chip"
              id="session-status"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className="avatar" aria-hidden="true">
                {(state.session?.displayName ?? state.session?.email ?? "U").slice(0, 1).toUpperCase()}
              </span>
              <span className="user-name">{state.session?.displayName ?? state.session?.email ?? "已登录"}</span>
            </button>
            {menuOpen ? (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <strong>{state.session?.displayName}</strong>
                  <span>{state.session?.email}</span>
                </div>
                <a href={href("/assets")} onClick={() => setMenuOpen(false)}>
                  资产总览
                </a>
                <a href={href("/assets/ledger")} onClick={() => setMenuOpen(false)}>
                  资金流水
                </a>
                <a href={href("/orders")} onClick={() => setMenuOpen(false)}>
                  订单中心
                </a>
                <a href={href("/account")} onClick={() => setMenuOpen(false)}>
                  账户与 API
                </a>
                <button
                  type="button"
                  id="logout-button"
                  onClick={() => {
                    setMenuOpen(false);
                    void actions.logout().then(() => navigate("/"));
                  }}
                >
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="auth-buttons">
            <Button variant="ghost" size="sm" onClick={() => navigate("/login")}>
              登录
            </Button>
            <Button variant="primary" size="sm" onClick={() => navigate("/login?mode=register")}>
              注册
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Toasts() {
  const { state, actions } = useExchange();
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          tone={toast.tone}
          title={toast.title}
          detail={toast.detail}
          onClose={() => actions.dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}

function ToastItem(props: {
  tone: "positive" | "negative" | "neutral";
  title: string;
  detail?: string;
  onClose: () => void;
}) {
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

export function BootScreen(props: { error: string | null }) {
  return (
    <div className="boot">
      <span className="brand-mark big" aria-hidden="true">
        ◆
      </span>
      {props.error ? (
        <>
          <strong>无法连接到 trader-web 服务</strong>
          <p>{props.error}</p>
          <code>pnpm demo:up</code>
        </>
      ) : (
        <p>正在连接交易所…</p>
      )}
    </div>
  );
}
