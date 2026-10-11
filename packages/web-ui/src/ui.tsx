import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";

/** Semantic colour of a status: drives badge / progress / toast colours. */
export type Tone = "positive" | "negative" | "warning" | "neutral" | "info";

/** Connection state of a realtime feed. */
export type FeedStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

type ButtonVariant = "primary" | "secondary" | "ghost" | "buy" | "sell" | "danger";

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: "sm" | "md" | "lg";
    loading?: boolean;
    block?: boolean;
  }
) {
  const { variant = "secondary", size = "md", loading, block, className, children, disabled, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={["btn", `btn-${variant}`, `btn-${size}`, block ? "btn-block" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Badge(props: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${props.tone ?? "neutral"}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function Tabs<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: ReactNode; count?: number }>;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div className={`tabs tabs-${props.size ?? "md"} ${props.className ?? ""}`} role="tablist">
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={props.value === item.value}
          className={props.value === item.value ? "tab active" : "tab"}
          onClick={() => props.onChange(item.value)}
        >
          {item.label}
          {item.count ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Panel(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  flush?: boolean;
}) {
  return (
    <section className={`panel ${props.className ?? ""}`} id={props.id}>
      {props.title || props.actions ? (
        <header className="panel-header">
          {props.title ? <h3 className="panel-title">{props.title}</h3> : <span />}
          {props.actions ? <div className="panel-actions">{props.actions}</div> : null}
        </header>
      ) : null}
      <div className={props.flush ? "panel-body flush" : "panel-body"}>{props.children}</div>
    </section>
  );
}

export function Empty(props: { title: string; hint?: ReactNode; action?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {props.icon ?? "○"}
      </div>
      <strong>{props.title}</strong>
      {props.hint ? <p>{props.hint}</p> : null}
      {props.action}
    </div>
  );
}

export function Modal(props: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) {
    return null;
  }
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={props.width ? { maxWidth: props.width } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{props.title}</h3>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function CopyButton(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard can be blocked; the value is still visible for manual copy.
        }
      }}
    >
      {copied ? "已复制" : (props.label ?? "复制")}
    </button>
  );
}

const FEED_LABEL: Record<FeedStatus, string> = {
  idle: "未连接",
  connecting: "连接中",
  live: "实时",
  reconnecting: "重连中",
  offline: "离线"
};

export function FeedDot(props: { status: FeedStatus; label: string; id?: string }) {
  return (
    <span className={`feed feed-${props.status}`} title={`${props.label}：${FEED_LABEL[props.status]}`}>
      <span className="feed-dot" />
      <span className="feed-label">{props.label}</span>
      <span className="feed-status" id={props.id} data-status={props.status}>
        {FEED_LABEL[props.status]}
      </span>
    </span>
  );
}

export function Field(props: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="field" htmlFor={props.htmlFor}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function Progress(props: { value: number; tone?: Tone }) {
  const percent = Math.round(Math.min(Math.max(props.value, 0), 1) * 100);
  return (
    <div className={`progress progress-${props.tone ?? "info"}`} aria-valuenow={percent} role="progressbar">
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Steps(props: { steps: Array<{ key: string; label: string }>; current: number; failed?: boolean }) {
  return (
    <ol className={`steps ${props.failed ? "steps-failed" : ""}`}>
      {props.steps.map((step, index) => (
        <li
          key={step.key}
          className={index < props.current ? "done" : index === props.current ? "current" : ""}
        >
          <span className="step-dot" />
          <span className="step-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function AssetIcon(props: { asset: string; size?: number }) {
  const size = props.size ?? 22;
  return (
    <span
      className={`asset-icon asset-${props.asset.toLowerCase()}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {props.asset.slice(0, 1)}
    </span>
  );
}
