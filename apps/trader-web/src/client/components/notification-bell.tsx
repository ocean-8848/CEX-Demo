import { useEffect, useMemo, useRef, useState } from "react";

import { formatDateTime } from "@web3-cex/web-ui";

import { describeNotification } from "../lib/notifications.js";
import { navigate } from "../lib/router.js";
import { useExchange } from "../state/store.js";

/**
 * M4-2 notification center: bell with the unread count (server-side read
 * markers from wallet-service) and a dropdown of the latest notifications.
 */
export function NotificationBell() {
  const { state, actions } = useExchange();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const views = useMemo(() => state.notifications.map(describeNotification), [state.notifications]);
  const unread = state.notificationUnread;

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className="icon-btn notif-bell"
        id="notification-bell"
        aria-label={unread > 0 ? `通知，${unread} 条未读` : "通知"}
        aria-expanded={open}
        title="通知中心"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.6L4.4 15.2A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .8-1.8L18 12.6V9a6 6 0 0 0-6-6Zm-2.4 15.5a2.5 2.5 0 0 0 4.8 0Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 ? (
          <span className="notif-count" id="notification-unread-count">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="notif-panel" role="dialog" aria-label="通知中心" id="notification-panel">
          <div className="notif-head">
            <strong>通知</strong>
            <span className="muted">{unread > 0 ? `${unread} 条未读` : "全部已读"}</span>
            <button
              type="button"
              className="notif-read-all"
              id="notification-read-all"
              disabled={unread === 0}
              onClick={() => void actions.markAllNotificationsRead()}
            >
              全部已读
            </button>
          </div>
          {views.length === 0 ? (
            <div className="notif-empty muted">暂无通知。充值到账、提现审核与上链进度会出现在这里。</div>
          ) : (
            <ul className="notif-list">
              {views.map((view, index) => {
                const record = state.notifications[index];
                return (
                  <li key={view.key}>
                    <button
                      type="button"
                      className={view.unread ? "notif-item unread" : "notif-item"}
                      data-notification-id={record?.notificationId}
                      onClick={() => {
                        if (view.unread && record?.notificationId) {
                          void actions.markNotificationRead(record.notificationId);
                        }
                        if (view.link) {
                          setOpen(false);
                          navigate(view.link);
                        }
                      }}
                    >
                      <span className={`notif-dot tone-${view.tone}`} aria-hidden="true" />
                      <span className="notif-text">
                        <b>{view.title}</b>
                        {view.detail ? <span>{view.detail}</span> : null}
                        <time className="muted">{formatDateTime(view.createdAt)}</time>
                      </span>
                      {view.link ? (
                        <span className="notif-go" aria-hidden="true">
                          ›
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="notif-foot muted">已读状态保存在服务端（wallet-service），刷新或换设备后保持一致</div>
        </div>
      ) : null}
    </div>
  );
}
