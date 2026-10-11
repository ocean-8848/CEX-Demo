import { useState } from "react";

import { Button, Empty, formatTime } from "@web3-cex/web-ui";

import { SERVICES, type ServiceKey } from "../../state/learn.js";
import { useExchange } from "../../state/store.js";
import { MatchReplayCard } from "./match-replay.js";

// Side drawer shown in "learning mode": a live timeline of what each backend
// service did for the user's last actions, plus a glossary of the services.
export function LearnDrawer() {
  const { state, actions } = useExchange();
  const [focus, setFocus] = useState<ServiceKey | null>(null);
  if (!state.prefs.learnMode) {
    return null;
  }
  const info = focus ? SERVICES[focus] : null;
  const tracingUiUrl = state.config?.tracingUiUrl;

  return (
    <aside className="learn-drawer" aria-label="学习模式" id="learn-drawer">
      <header className="learn-head">
        <div>
          <strong>幕后发生了什么</strong>
          <span>每个操作经过的服务会实时出现在这里</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭学习模式"
          onClick={() => actions.setPrefs({ learnMode: false })}
        >
          ✕
        </button>
      </header>

      {info ? (
        <div className="learn-service">
          <div className="learn-service-head">
            <span className={`svc svc-${info.key}`}>{info.name}</span>
            <span className="learn-layer">{info.layer}</span>
          </div>
          <strong>{info.summary}</strong>
          <p>{info.detail}</p>
          <code>{info.code}</code>
          <Button size="sm" variant="ghost" onClick={() => setFocus(null)}>
            返回时间线
          </Button>
        </div>
      ) : (
        <>
          {state.matchReplay ? (
            <MatchReplayCard replay={state.matchReplay} onClose={actions.dismissMatchReplay} />
          ) : null}
          <div className="learn-timeline">
            {state.learnEvents.length === 0 ? (
              <Empty
                icon="🎓"
                title="还没有事件"
                hint="试着下一笔单、撤单或领取测试币，这里会按顺序展示请求经过的每个服务。"
              />
            ) : (
              <ol>
                {state.learnEvents.map((event) => (
                  <li key={event.id} className={`learn-item tone-${event.tone ?? "neutral"}`}>
                    <div className="learn-item-head">
                      <button
                        type="button"
                        className={`svc svc-${event.service}`}
                        onClick={() => setFocus(event.service)}
                        title="查看这个服务的职责"
                      >
                        {event.service}
                      </button>
                      <time>{formatTime(event.at)}</time>
                    </div>
                    <strong>{event.title}</strong>
                    {event.detail ? <p>{event.detail}</p> : null}
                    {event.traceId ? (
                      tracingUiUrl ? (
                        <a
                          className="learn-trace"
                          href={`${tracingUiUrl}/trace/${event.traceId}`}
                          target="_blank"
                          rel="noreferrer"
                          title="在 Jaeger 中查看这次请求跨服务的完整调用链"
                        >
                          查看 trace ↗
                        </a>
                      ) : (
                        <span className="learn-trace muted" title="用 pnpm stack:start:observability 启动后可在 Jaeger 中查看">
                          trace {event.traceId.slice(0, 8)}…
                        </span>
                      )
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <footer className="learn-foot">
            <span>点击服务名查看职责</span>
            {state.learnEvents.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={actions.clearLearn}>
                清空
              </Button>
            ) : null}
          </footer>
        </>
      )}
    </aside>
  );
}
