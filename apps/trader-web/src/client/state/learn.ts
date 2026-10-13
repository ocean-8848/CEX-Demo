// "Learning mode" data: which backend service did what, in plain language.
// The Learn drawer renders a live timeline of LearnEvents so a user can watch
// an order or a deposit travel through the system.

import { formatAmount, marketLabel } from "@web3-cex/web-ui";

import { describeFundingStatus, describeOrderStatus } from "../lib/records.js";
import { describeOrderReason } from "../lib/order-options.js";
import type {
  BalanceRecord,
  DepositRecord,
  OrderRecord,
  PrivateChannel,
  TradeRecord,
  WithdrawalRecord
} from "../lib/types.js";

export type ServiceKey =
  | "trader-web"
  | "api-gateway"
  | "identity-service"
  | "risk-service"
  | "order-service"
  | "ledger-service"
  | "matching-engine"
  | "settlement-service"
  | "market-data-service"
  | "wallet-service"
  | "blockchain-indexer"
  | "custody-adapter"
  | "demo-simulator";

export interface ServiceInfo {
  key: ServiceKey;
  name: string;
  layer: "接入层" | "交易层" | "资金层" | "演示环境";
  summary: string;
  detail: string;
  code: string;
}

export const SERVICES: Record<ServiceKey, ServiceInfo> = {
  "trader-web": {
    key: "trader-web",
    name: "trader-web",
    layer: "接入层",
    summary: "用户交易前台",
    detail:
      "React 单页应用 + 一个极薄的 Node Web Host：托管静态资源、注入运行时配置，并把 /api/* 同源代理到网关与行情服务，避免浏览器跨域。",
    code: "apps/trader-web"
  },
  "api-gateway": {
    key: "api-gateway",
    name: "api-gateway",
    layer: "接入层",
    summary: "鉴权、限流、幂等、私有 WebSocket",
    detail:
      "所有用户请求的唯一入口：校验 Session / API Key 签名、按用户限流、用 Idempotency-Key 防止重复下单，并校验资源归属（只能操作自己的账户）。私有推送也从这里发出。",
    code: "services/api-gateway"
  },
  "identity-service": {
    key: "identity-service",
    name: "identity-service",
    layer: "资金层",
    summary: "用户、会话、2FA、KYC、API Key",
    detail: "负责注册登录、会话签发、TOTP 二次验证（含一次性恢复码，只存哈希）、KYC 等级和 API Key 管理。网关每次请求都会向它确认身份。",
    code: "services/identity-service"
  },
  "risk-service": {
    key: "risk-service",
    name: "risk-service",
    layer: "交易层",
    summary: "下单前风控",
    detail:
      "先确认市场处于交易中（运营在后台「市场管理」暂停的市场会以 MARKET_HALTED 拒绝新委托，撤单不受影响），再检查最小数量、价格/数量步长、价格偏离参考价是否超过 ±20%（参考价实时取最新成交价，无成交时取盘口中间价，行情不可用时才用 config/markets.json 的配置值），并计算需要冻结的金额（买单冻结计价币，卖单冻结基础币）。市场规则全部来自 config/markets.json。",
    code: "services/risk-service"
  },
  "order-service": {
    key: "order-service",
    name: "order-service",
    layer: "交易层",
    summary: "订单生命周期编排",
    detail:
      "交易主链的编排者：调风控 → 调账本冻结资金 → 把订单送进撮合引擎 → 把成交交给结算 → 推送订单/成交事件。异常时进入可重试的恢复队列。止损单先以「待触发」保存，StopOrderTriggerWorker 按最新成交价触发后再送进撮合引擎。",
    code: "services/order-service"
  },
  "ledger-service": {
    key: "ledger-service",
    name: "ledger-service",
    layer: "资金层",
    summary: "双分录账本",
    detail:
      "所有资金变动都是一笔借贷平衡的分录（journal）。余额分为可用（available）和冻结（locked）：下单冻结、撤单解冻、成交消耗冻结并入账对手资产。",
    code: "services/ledger-service"
  },
  "matching-engine": {
    key: "matching-engine",
    name: "matching-engine",
    layer: "交易层",
    summary: "Rust 撮合引擎",
    detail:
      "内存订单簿，按「价格优先、时间优先」撮合。支持 limit / market 与 GTC / IOC / FOK，以及只做 Maker（post-only）和自成交保护（STP，同一账户的买卖单不互相成交）。它只负责撮合，不碰资金。",
    code: "engines/matching-engine"
  },
  "settlement-service": {
    key: "settlement-service",
    name: "settlement-service",
    layer: "交易层",
    summary: "成交结算",
    detail:
      "把每一笔成交变成账本分录：买方消耗冻结的 USDT 得到 ETH，卖方消耗冻结的 ETH 得到 USDT。双方各自从收到的资产中扣手续费（挂单方 Maker 0.05%、吃单方 Taker 0.1%），计入平台手续费账户。按 tradeId 幂等，可安全重放。",
    code: "services/settlement-service"
  },
  "market-data-service": {
    key: "market-data-service",
    name: "market-data-service",
    layer: "交易层",
    summary: "行情：Ticker / 深度 / 成交 / K 线",
    detail: "订阅交易事件，聚合出 24h 行情、订单簿深度和 K 线，通过 REST 和公共 WebSocket 推送给所有人。",
    code: "services/market-data-service"
  },
  "wallet-service": {
    key: "wallet-service",
    name: "wallet-service",
    layer: "资金层",
    summary: "充值地址、充提记录、提现审核",
    detail:
      "为用户分配充值地址；充值达到确认数后通知账本入账；提现先校验 2FA、KYC 分级限额与安全冷却期，再冻结资金，经运营审核（大额需两人复核）后交给托管从热钱包广播。它还管理冷热分层：把充值地址里的币归集到热钱包，按热钱包水位提出冷热调拨（需运营审批），并生成储备金证明（Merkle 树）。",
    code: "services/wallet-service"
  },
  "blockchain-indexer": {
    key: "blockchain-indexer",
    name: "blockchain-indexer",
    layer: "资金层",
    summary: "链上扫描与确认数推进",
    detail:
      "扫描区块，发现打到平台地址的转账，并随着新区块推进确认数；也会跟踪提现交易是否上链确认，处理链重组。",
    code: "services/blockchain-indexer"
  },
  "custody-adapter": {
    key: "custody-adapter",
    name: "custody-adapter",
    layer: "资金层",
    summary: "托管 / 热钱包签名广播",
    detail: "对接托管商或热钱包，负责签名并广播提现交易，以及归集、冷热调拨这类平台内部转账；带重试、熔断和多 provider 路由。",
    code: "services/custody-adapter"
  },
  "demo-simulator": {
    key: "demo-simulator",
    name: "demo-simulator",
    layer: "演示环境",
    summary: "模拟链 + 做市商",
    detail:
      "仅用于学习环境：模拟一条每 1.5 秒出块的 EVM 链（推进充值、提现、归集与冷热调拨的确认数，并定时触发归集与水位检查），并用两个做市账户在盘口挂单、偶尔吃单，让行情和 K 线动起来。",
    code: "scripts/demo-simulator.mjs"
  }
};

export interface LearnEvent {
  id: string;
  at: string;
  service: ServiceKey;
  title: string;
  detail?: string;
  tone?: "positive" | "negative" | "neutral";
  /** OpenTelemetry trace id; rendered as a Jaeger link when tracing is on. */
  traceId?: string;
}

let counter = 0;
export function learnEvent(event: Omit<LearnEvent, "id" | "at">): LearnEvent {
  counter += 1;
  return { id: `ev-${Date.now()}-${counter}`, at: new Date().toISOString(), ...event };
}

/** Explains a private realtime delta in terms of which service produced it. */
export function explainPrivateItems(channel: PrivateChannel, items: unknown[]): LearnEvent[] {
  return items.slice(0, 4).flatMap((raw): LearnEvent[] => {
    switch (channel) {
      case "orders": {
        const order = raw as OrderRecord;
        const status = describeOrderStatus(order.status);
        const reason = describeOrderReason(order.rejectedReason);
        const triggered = order.triggeredAt && order.status !== "pending_trigger";
        return [
          learnEvent({
            service: "order-service",
            title: `${triggered ? "止损单已触发，" : ""}订单${status.label}：${order.side === "sell" ? "卖出" : "买入"} ${formatAmount(order.quantity)} ${marketLabel(order.market ?? "")}`,
            detail: reason ? `${status.hint}。原因：${reason}` : status.hint,
            tone: status.tone === "negative" ? "negative" : status.tone === "positive" ? "positive" : "neutral"
          })
        ];
      }
      case "trades": {
        const trade = raw as TradeRecord;
        return [
          learnEvent({
            service: "matching-engine",
            title: `撮合成交 ${formatAmount(trade.quantity)} @ ${formatAmount(trade.price, 2)}`,
            detail: "撮合引擎按价格优先、时间优先配对；随后 settlement-service 按 tradeId 幂等结算。",
            tone: "positive"
          })
        ];
      }
      case "balances": {
        const balance = raw as BalanceRecord;
        return [
          learnEvent({
            service: "ledger-service",
            title: `${balance.assetCode} 余额更新：可用 ${formatAmount(balance.available)} / 冻结 ${formatAmount(balance.locked)}`,
            detail: "账本记录了一笔借贷平衡的分录；冻结 = 已下单但未成交的资金。"
          })
        ];
      }
      case "deposits": {
        const deposit = raw as DepositRecord;
        return [
          learnEvent({
            service: "wallet-service",
            title: `充值${describeFundingStatus(deposit.status, "deposit").label}：${formatAmount(deposit.amount)} ${deposit.assetCode ?? ""}`,
            detail: "blockchain-indexer 报告确认数达标后，wallet-service 通知账本入账。",
            tone: deposit.status === "credited" ? "positive" : "neutral"
          })
        ];
      }
      case "withdrawals": {
        const withdrawal = raw as WithdrawalRecord;
        return [
          learnEvent({
            service: "wallet-service",
            title: `提现${describeFundingStatus(withdrawal.status, "withdrawal").label}：${formatAmount(withdrawal.amount)} ${withdrawal.assetCode ?? ""}`,
            detail:
              withdrawal.status === "under_review" || withdrawal.status === "requested"
                ? "资金已冻结，等待运营后台（ops-console）人工审核。"
                : withdrawal.status === "broadcasted"
                  ? "custody-adapter 已签名广播，blockchain-indexer 正在等待链上确认。"
                  : undefined,
            tone: withdrawal.status === "confirmed" ? "positive" : withdrawal.status === "rejected" ? "negative" : "neutral"
          })
        ];
      }
      default:
        return [];
    }
  });
}
