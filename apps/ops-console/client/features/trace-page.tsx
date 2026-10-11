import { useEffect, useState, type FormEvent } from "react";

import { Button, Empty, Panel, Spinner, navigate } from "@web3-cex/web-ui";

import { qs, readErrorMessage } from "../lib/api.js";
import type { BusinessTrace } from "../lib/types.js";
import { IdLink, JsonView, PageHeader, StatusBadge, Time, type TraceKey } from "../components/kit.js";
import { useSession } from "../state/session.js";

const KINDS: Array<{ key: TraceKey; label: string; entity: string }> = [
  { key: "withdrawalId", label: "提现单", entity: "withdrawal" },
  { key: "orderId", label: "订单", entity: "order" },
  { key: "tradeId", label: "成交", entity: "trade" },
  { key: "depositId", label: "充值单", entity: "deposit" },
  { key: "userId", label: "用户", entity: "user" },
  { key: "accountId", label: "账本账户", entity: "balances" },
  { key: "txHash", label: "链上交易", entity: "indexerObservation" }
];

const MODULE_LABEL: Record<string, string> = {
  "identity-service": "身份",
  "wallet-service": "钱包",
  "ledger-service": "账本",
  "blockchain-indexer": "链上观察",
  "custody-adapter": "托管",
  "order-service": "订单",
  "matching-engine": "撮合",
  "settlement-service": "结算",
  "api-gateway": "网关 / 通知",
  "risk-service": "风控",
  "market-data-service": "行情"
};

function hasEntity(trace: BusinessTrace, entity: string): boolean {
  const value = trace.entities?.[entity];
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (entity === "indexerObservation") {
    return Boolean(trace.entities?.indexerObservation ?? trace.entities?.deposit ?? trace.entities?.withdrawal);
  }
  return value !== null && value !== undefined;
}

export function TracePage(props: { query: URLSearchParams }) {
  const { api } = useSession();
  const [trace, setTrace] = useState<BusinessTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<TraceKey | "auto">("auto");
  const [value, setValue] = useState("");

  // Read the selector from the URL: `?orderId=…` or free-text `?q=…`.
  const selector = KINDS.find((item) => props.query.get(item.key));
  const freeText = props.query.get("q") ?? "";
  const urlKey = selector ? `${selector.key}=${props.query.get(selector.key)}` : freeText ? `q=${freeText}` : "";

  useEffect(() => {
    if (selector) {
      setKind(selector.key);
      setValue(props.query.get(selector.key) ?? "");
    } else if (freeText) {
      setKind("auto");
      setValue(freeText);
    }
    if (!urlKey) {
      setTrace(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let result: BusinessTrace | null = null;
        if (selector) {
          result = await api<BusinessTrace>(`/business-trace${qs({ [selector.key]: props.query.get(selector.key), limit: 50 })}`);
        } else {
          // Free text: 0x… is a tx hash; otherwise try each id kind until one resolves.
          const candidates = freeText.startsWith("0x") ? KINDS.filter((item) => item.key === "txHash") : KINDS.filter((item) => item.key !== "txHash");
          for (const candidate of candidates) {
            const attempt = await api<BusinessTrace>(`/business-trace${qs({ [candidate.key]: freeText, limit: 50 })}`).catch(() => null);
            if (attempt && hasEntity(attempt, candidate.entity)) {
              result = attempt;
              break;
            }
          }
          if (!result) {
            throw new Error(`没有找到与 ${freeText} 关联的业务对象`);
          }
        }
        if (!cancelled) {
          setTrace(result);
        }
      } catch (traceError) {
        if (!cancelled) {
          setTrace(null);
          setError(readErrorMessage(traceError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, api]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    navigate(kind === "auto" ? `/trace?q=${encodeURIComponent(trimmed)}` : `/trace?${kind}=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="page">
      <PageHeader title="业务追踪" subtitle="输入任意业务主键，把同一笔业务在身份、钱包、账本、撮合、结算、链上各模块中的状态串成一条链" />
      <Panel>
        <form className="trace-form" onSubmit={submit} id="trace-form">
          <select value={kind} onChange={(event) => setKind(event.target.value as TraceKey | "auto")} aria-label="主键类型">
            <option value="auto">自动识别</option>
            {KINDS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}（{item.key}）
              </option>
            ))}
          </select>
          <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="粘贴 userId / orderId / withdrawalId / txHash …" name="traceValue" />
          <Button type="submit" variant="primary" loading={loading}>
            追踪
          </Button>
        </form>
      </Panel>

      {loading && !trace ? (
        <div className="query-loading"><Spinner /> 正在跨模块联查…</div>
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : trace ? (
        <TraceResult trace={trace} />
      ) : (
        <Empty icon="⌖" title="从一个主键开始" hint="例如在「提现审核」或「交易与结算」里点击任意蓝色 ID，会直接跳到这里。" />
      )}
    </div>
  );
}

// Orders keep `otelTraceId`; withdrawals keep it in `metadata.otelTraceId`.
function otelTracesOf(trace: BusinessTrace): Array<{ label: string; traceId: string }> {
  const found: Array<{ label: string; traceId: string }> = [];
  for (const [name, value] of Object.entries(trace.entities ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const metadata = (record.metadata ?? {}) as Record<string, unknown>;
      const traceId = record.otelTraceId ?? metadata.otelTraceId;
      if (typeof traceId === "string" && !found.some((entry) => entry.traceId === traceId)) {
        found.push({ label: name, traceId });
      }
    }
  }
  return found;
}

function OtelTraceLinks(props: { trace: BusinessTrace }) {
  const traces = otelTracesOf(props.trace);
  if (traces.length === 0) {
    return null;
  }
  return (
    <div className="trace-inferred" id="otel-trace-links">
      <span className="muted small">OpenTelemetry 调用链：</span>
      {traces.map((entry) =>
        props.trace.tracingUiUrl ? (
          <a
            key={entry.traceId}
            className="inferred-chip"
            href={`${props.trace.tracingUiUrl}/trace/${entry.traceId}`}
            target="_blank"
            rel="noreferrer"
          >
            {entry.label} 在 Jaeger 中查看 ↗
          </a>
        ) : (
          <span key={entry.traceId} className="inferred-chip" title="用 pnpm stack:start:observability 启动后可在 Jaeger 中查看">
            {entry.label} trace <code>{entry.traceId.slice(0, 12)}…</code>
          </span>
        )
      )}
    </div>
  );
}

function TraceResult(props: { trace: BusinessTrace }) {
  const { trace } = props;
  const entities = Object.entries(trace.entities ?? {}).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined
  );
  const related = Object.entries(trace.related ?? {}).filter(([, value]) => Array.isArray(value) && value.length > 0) as Array<[string, Array<Record<string, unknown>>]>;

  return (
    <div className="trace-result" id="trace-result">
      <Panel>
        <div className="trace-root">
          <span className="trace-kind">{trace.root?.kind}</span>
          <h2>{trace.root?.label}</h2>
          <p className="muted">{trace.root?.explanation}</p>
          <OtelTraceLinks trace={trace} />
          {Object.keys(trace.inferred ?? {}).length > 0 ? (
            <div className="trace-inferred">
              <span className="muted small">已推导出的关联主键：</span>
              {Object.entries(trace.inferred ?? {}).map(([key, id]) => (
                <span key={key} className="inferred-chip">
                  {key} <IdLink id={id} kind={key as TraceKey} />
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      <div className="grid-2 wide-left">
        <Panel title="跨模块链路">
          <ol className="trace-steps">
            {(trace.steps ?? []).map((step, index) => (
              <li key={`${step.moduleId}:${index}`}>
                <span className="trace-step-no">{index + 1}</span>
                <div>
                  <div className="trace-step-head">
                    <code className="module-tag">{step.moduleId}</code>
                    <span className="muted small">{MODULE_LABEL[step.moduleId] ?? ""}</span>
                  </div>
                  <strong>{step.title}</strong>
                  <ul>
                    {step.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title="命中的业务对象">
          <div className="entity-list">
            {entities.map(([name, value]) => (
              <EntityCard key={name} name={name} value={value} />
            ))}
          </div>
        </Panel>
      </div>

      {related.length > 0 ? (
        <Panel title="关联记录">
          <div className="related-grid">
            {related.map(([name, items]) => (
              <div key={name} className="related-block">
                <h4>
                  {name} <span className="muted small">{items.length}</span>
                </h4>
                <ul className="plain-list">
                  {items.slice(0, 6).map((item, index) => (
                    <li key={String(item[idKeyOf(item)] ?? index)}>
                      <IdLink id={String(item[idKeyOf(item)] ?? "")} kind={traceKindOf(idKeyOf(item))} />{" "}
                      {item.status ? <StatusBadge status={String(item.status)} /> : null}{" "}
                      <Time value={String(item.updatedAt ?? item.createdAt ?? item.executedAt ?? item.requestedAt ?? "")} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      <JsonView value={trace} label="完整追踪结果（JSON）" />
    </div>
  );
}

function EntityCard(props: { name: string; value: unknown }) {
  const record = Array.isArray(props.value) ? undefined : (props.value as Record<string, unknown>);
  const idKey = record ? idKeyOf(record) : undefined;
  return (
    <div className="entity-card">
      <div className="entity-head">
        <strong>{props.name}</strong>
        {record?.status ? <StatusBadge status={String(record.status)} /> : null}
        {Array.isArray(props.value) ? <span className="muted small">{props.value.length} 条</span> : null}
      </div>
      {record && idKey ? <IdLink id={String(record[idKey])} kind={traceKindOf(idKey)} head={12} /> : null}
      <JsonView value={props.value} label="详情" />
    </div>
  );
}

function idKeyOf(record: Record<string, unknown>): string {
  for (const key of ["withdrawalId", "depositId", "orderId", "tradeId", "settlementId", "notificationId", "observationId", "auditLogId", "userId", "accountId"]) {
    if (record[key]) {
      return key;
    }
  }
  return Object.keys(record)[0] ?? "id";
}

function traceKindOf(key: string): TraceKey | undefined {
  return (["userId", "accountId", "orderId", "tradeId", "depositId", "withdrawalId", "txHash"] as string[]).includes(key)
    ? (key as TraceKey)
    : undefined;
}
