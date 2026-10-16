import { useEffect, useMemo, useState } from "react";

import { Button } from "@web3-cex/web-ui";

import { navigate, type PageKey } from "../../lib/router.js";
import {
  TOURS,
  baselineOf,
  currentStepIndex,
  type TourBaseline,
  type TourDefinition,
  type TourSnapshot
} from "../../lib/tours.js";
import { useExchange } from "../../state/store.js";

const STORAGE_KEY = "trader-web:tour";

interface TourProgress {
  tourId: string;
  baseline: TourBaseline;
  confirmed: string[];
  reached: number;
}

function readProgress(): TourProgress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as TourProgress) : null;
    // Ignore progress saved by an older build with a different baseline shape.
    return parsed?.baseline?.startedAt ? parsed : null;
  } catch {
    return null;
  }
}

function writeProgress(progress: TourProgress | null): void {
  try {
    if (progress) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Progress then only lives for this page view.
  }
}

/** Guided scenarios: a picker plus a floating checklist for the running tour. */
export function TourPanel(props: { page: PageKey }) {
  const { state } = useExchange();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<TourProgress | null>(() => readProgress());

  const snapshot: TourSnapshot = useMemo(
    () => ({
      loggedIn: Boolean(state.session),
      page: props.page,
      orders: state.orders,
      trades: state.trades,
      deposits: state.deposits,
      withdrawals: state.withdrawals
    }),
    [state.session, props.page, state.orders, state.trades, state.deposits, state.withdrawals]
  );

  const tour = progress ? TOURS.find((item) => item.id === progress.tourId) ?? null : null;
  const stepIndex = tour && progress
    ? currentStepIndex(tour, { snapshot, baseline: progress.baseline }, progress.confirmed, progress.reached)
    : 0;

  // Remember how far the user got so a refresh does not rewind the checklist.
  useEffect(() => {
    if (progress && stepIndex > progress.reached) {
      const next = { ...progress, reached: stepIndex };
      setProgress(next);
      writeProgress(next);
    }
  }, [progress, stepIndex]);

  const step = tour?.steps[stepIndex];
  useEffect(() => {
    if (!step?.target) {
      return;
    }
    const elements = Array.from(document.querySelectorAll<HTMLElement>(step.target));
    elements.forEach((element) => element.classList.add("tour-highlight"));
    return () => elements.forEach((element) => element.classList.remove("tour-highlight"));
  }, [step?.target, props.page, state.session]);

  const start = (definition: TourDefinition) => {
    const next: TourProgress = { tourId: definition.id, baseline: baselineOf(), confirmed: [], reached: 0 };
    setProgress(next);
    writeProgress(next);
  };
  const stop = () => {
    setProgress(null);
    writeProgress(null);
  };
  const confirm = (stepId: string) => {
    if (!progress) {
      return;
    }
    const next = { ...progress, confirmed: [...progress.confirmed, stepId] };
    setProgress(next);
    writeProgress(next);
  };
  const opsUrl = state.config?.opsConsoleUrl ?? "http://127.0.0.1:3006";

  if (tour && progress) {
    const finished = stepIndex >= tour.steps.length;
    return (
      <aside className="tour-panel" id="tour-panel" aria-label="场景导览">
        <header className="tour-head">
          <div>
            <span className="tour-kicker">场景导览</span>
            <strong>{tour.title}</strong>
          </div>
          <button type="button" className="icon-btn" aria-label="退出导览" onClick={stop}>
            ✕
          </button>
        </header>
        <ol className="tour-steps">
          {tour.steps.map((item, index) => (
            <li
              key={item.id}
              className={index < stepIndex ? "done" : index === stepIndex ? "active" : "todo"}
              data-step={item.id}
            >
              <span className="tour-step-mark" aria-hidden="true">
                {index < stepIndex ? "✓" : index + 1}
              </span>
              <div>
                <strong>{item.title}</strong>
                {index === stepIndex ? (
                  <>
                    <p>{item.body}</p>
                    <div className="tour-actions">
                      {item.link?.path ? (
                        <Button size="sm" onClick={() => navigate(item.link!.path!)}>
                          {item.link.label}
                        </Button>
                      ) : null}
                      {item.link?.external ? (
                        <a
                          className="btn btn-sm"
                          href={item.link.external.replace("{ops}", opsUrl)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.link.label} ↗
                        </a>
                      ) : null}
                      {item.done ? (
                        <span className="muted small">完成后自动进入下一步</span>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => confirm(item.id)}>
                          我已完成
                        </Button>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {finished ? (
          <footer className="tour-foot" id="tour-finished">
            <strong>🎉 场景完成</strong>
            <Button size="sm" variant="ghost" onClick={stop}>
              选择其他场景
            </Button>
          </footer>
        ) : null}
      </aside>
    );
  }

  if (!open) {
    return (
      <button type="button" className="tour-launcher" id="tour-launcher" onClick={() => setOpen(true)}>
        🧭 场景导览
      </button>
    );
  }

  return (
    <aside className="tour-panel" id="tour-picker" aria-label="选择场景">
      <header className="tour-head">
        <div>
          <span className="tour-kicker">场景导览</span>
          <strong>跟着步骤体验一家交易所</strong>
        </div>
        <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setOpen(false)}>
          ✕
        </button>
      </header>
      <ul className="tour-list">
        {TOURS.map((definition) => (
          <li key={definition.id}>
            <button
              type="button"
              data-tour={definition.id}
              onClick={() => {
                start(definition);
                setOpen(false);
              }}
            >
              <strong>{definition.title}</strong>
              <span>{definition.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
