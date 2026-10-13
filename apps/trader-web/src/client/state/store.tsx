import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from "react";

import { formatAmount, marketLabel } from "@web3-cex/web-ui";

import {
  COOKIE_SESSION,
  createApiClient,
  createIdempotencyKey,
  fetchConfig,
  fetchJson,
  itemsOf,
  readErrorMessage,
  takeLastTraceId,
  type ApiClient
} from "../lib/api.js";
import { getDeviceId } from "../lib/device.js";
import { fetchTradeJournals, type TradeJournalView } from "../lib/journals.js";
import { countNewUnread, keepReadMarkers } from "../lib/notifications.js";
import { explainMatch, type MatchExplanation } from "../lib/match-explain.js";
import {
  describeFundingStatus,
  isOpenOrder,
  mergeRecords,
  spotAccountId as spotAccountIdOf,
  summarizeBalances,
  type AssetBalance
} from "../lib/records.js";
import type {
  AccountEventRecord,
  AddressBookEntry,
  ApiKeyRecord,
  ApiKeyScope,
  BalanceRecord,
  DepositAddressRecord,
  DepositRecord,
  DepthSnapshot,
  FaucetReceipt,
  KycProfile,
  MarketDefinition,
  MarketTicker,
  NotificationRecord,
  OrderRecord,
  OrderSide,
  OrderType,
  PrivateChannel,
  PrivateRealtimeMessage,
  PublicRealtimeMessage,
  SessionDevice,
  SessionInfo,
  StpMode,
  TimeInForce,
  TradeRecord,
  TraderWebRuntimeConfig,
  TwoFactorEnrollment,
  TwoFactorStatus,
  WithdrawalLimits,
  WithdrawalRecord
} from "../lib/types.js";
import { describeOrderReason, engineTypeOf, isStopType } from "../lib/order-options.js";
import { explainPrivateItems, learnEvent, type LearnEvent } from "./learn.js";
import { ManagedSocket, type FeedStatus } from "./socket.js";

// Older builds stored the bearer token here; it is cleared on boot (M5-1).
const LEGACY_TOKEN_KEY = "trader-web:token";
// Non-secret hint that a cookie session probably exists, so boot checks it.
const SIGNED_IN_KEY = "trader-web:signed-in";
const SEQUENCE_KEY = "trader-web:last-sequence";
const PREFS_KEY = "trader-web:prefs";
const PRIVATE_CHANNELS: PrivateChannel[] = [
  "orders",
  "trades",
  "balances",
  "notifications",
  "deposits",
  "withdrawals",
  "account_events"
];

export interface Toast {
  id: string;
  tone: "positive" | "negative" | "neutral";
  title: string;
  detail?: string;
}

/** M3-4: the last order's matching walk, shown in the learn drawer. */
export interface MatchReplay {
  orderId: string;
  market: string;
  createdAt: string;
  explanation: MatchExplanation;
}

export interface Preferences {
  theme: "dark" | "light";
  learnMode: boolean;
}

export interface ExchangeState {
  config: TraderWebRuntimeConfig | null;
  bootError: string | null;
  market: string;
  tickers: Record<string, MarketTicker>;
  depth: DepthSnapshot;
  publicTrades: TradeRecord[];
  publicFeed: FeedStatus;
  token: string;
  session: SessionInfo | null;
  /** The user's spot ledger account (provisioned by the gateway on first use). */
  spotAccountId: string;
  balances: BalanceRecord[];
  orders: OrderRecord[];
  trades: TradeRecord[];
  depositAddresses: DepositAddressRecord[];
  deposits: DepositRecord[];
  withdrawals: WithdrawalRecord[];
  addressBook: AddressBookEntry[];
  notifications: NotificationRecord[];
  /** M4-2: unread notifications (server count, bumped by realtime events). */
  notificationUnread: number;
  accountEvents: AccountEventRecord[];
  apiKeys: ApiKeyRecord[];
  /** M4-1 / M4-4 / M5-2 account security snapshot (null until loaded). */
  twoFactor: TwoFactorStatus | null;
  kyc: KycProfile | null;
  withdrawalLimits: WithdrawalLimits | null;
  privateFeed: FeedStatus;
  lastSequence: number;
  accountLoading: boolean;
  learnEvents: LearnEvent[];
  matchReplay: MatchReplay | null;
  toasts: Toast[];
  prefs: Preferences;
}

type Action =
  | { type: "booted"; config: TraderWebRuntimeConfig }
  | { type: "bootFailed"; error: string }
  | { type: "selectMarket"; market: string }
  | { type: "tickers"; tickers: MarketTicker[] }
  | { type: "depth"; depth: DepthSnapshot }
  | { type: "publicTrades"; trades: TradeRecord[] }
  | { type: "publicFeed"; status: FeedStatus }
  | { type: "privateFeed"; status: FeedStatus }
  | { type: "loggedIn"; token: string; session: SessionInfo }
  | { type: "loggedOut" }
  | { type: "accountLoading"; loading: boolean }
  | { type: "accountSnapshot"; snapshot: Partial<ExchangeState> }
  | { type: "privateItems"; channel: PrivateChannel; items: unknown[] }
  | { type: "sequence"; sequence: number }
  | { type: "learn"; events: LearnEvent[] }
  | { type: "clearLearn" }
  | { type: "notificationUnread"; count: number }
  | { type: "notificationUnreadAdd"; delta: number }
  | { type: "notificationsRead"; ids?: string[]; readAt: string; unreadCount?: number }
  | { type: "matchReplay"; replay: MatchReplay | null }
  | { type: "toast"; toast: Toast }
  | { type: "dismissToast"; id: string }
  | { type: "prefs"; prefs: Partial<Preferences> };

function loadPrefs(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Preferences>;
    return { theme: stored.theme === "light" ? "light" : "dark", learnMode: Boolean(stored.learnMode) };
  } catch {
    return { theme: "dark", learnMode: false };
  }
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage can be unavailable (private mode); the app still works without it.
  }
}

const EMPTY_PRIVATE: Pick<
  ExchangeState,
  | "session"
  | "spotAccountId"
  | "balances"
  | "orders"
  | "trades"
  | "depositAddresses"
  | "deposits"
  | "withdrawals"
  | "addressBook"
  | "notifications"
  | "notificationUnread"
  | "accountEvents"
  | "apiKeys"
  | "twoFactor"
  | "kyc"
  | "withdrawalLimits"
> = {
  session: null,
  spotAccountId: "",
  balances: [],
  orders: [],
  trades: [],
  depositAddresses: [],
  deposits: [],
  withdrawals: [],
  addressBook: [],
  notifications: [],
  notificationUnread: 0,
  accountEvents: [],
  apiKeys: [],
  twoFactor: null,
  kyc: null,
  withdrawalLimits: null
};

function initialState(): ExchangeState {
  return {
    config: null,
    bootError: null,
    // Filled from config.defaultMarket (config/markets.json) once the runtime config loads.
    market: "",
    tickers: {},
    depth: { bids: [], asks: [] },
    publicTrades: [],
    publicFeed: "idle",
    token: readStorage(SIGNED_IN_KEY) === "1" ? COOKIE_SESSION : "",
    ...EMPTY_PRIVATE,
    privateFeed: "offline",
    lastSequence: Number(readStorage(SEQUENCE_KEY) || "0"),
    accountLoading: false,
    learnEvents: [],
    matchReplay: null,
    toasts: [],
    prefs: loadPrefs()
  };
}

function reducer(state: ExchangeState, action: Action): ExchangeState {
  switch (action.type) {
    case "booted": {
      const markets = action.config.markets.map((item) => item.market);
      return {
        ...state,
        config: action.config,
        market: markets.includes(state.market)
          ? state.market
          : markets.includes(action.config.defaultMarket)
            ? action.config.defaultMarket
            : (markets[0] ?? state.market)
      };
    }
    case "bootFailed":
      return { ...state, bootError: action.error };
    case "selectMarket":
      if (action.market === state.market) {
        return state;
      }
      return { ...state, market: action.market, depth: { bids: [], asks: [] }, publicTrades: [] };
    case "tickers": {
      const tickers = { ...state.tickers };
      for (const ticker of action.tickers) {
        tickers[ticker.market] = ticker;
      }
      return { ...state, tickers };
    }
    case "depth":
      if (action.depth.market && action.depth.market !== state.market) {
        return state;
      }
      return { ...state, depth: action.depth };
    case "publicTrades":
      return { ...state, publicTrades: action.trades.slice(0, 60) };
    case "publicFeed":
      return { ...state, publicFeed: action.status };
    case "privateFeed":
      return { ...state, privateFeed: action.status };
    case "loggedIn":
      return { ...state, token: action.token, session: action.session };
    case "loggedOut":
      return { ...state, token: "", ...EMPTY_PRIVATE, privateFeed: "offline", lastSequence: 0 };
    case "accountLoading":
      return { ...state, accountLoading: action.loading };
    case "accountSnapshot":
      return { ...state, ...action.snapshot, accountLoading: false };
    case "privateItems":
      return applyPrivateItems(state, action.channel, action.items);
    case "sequence":
      return { ...state, lastSequence: action.sequence };
    case "learn":
      return { ...state, learnEvents: [...[...action.events].reverse(), ...state.learnEvents].slice(0, 80) };
    case "clearLearn":
      return { ...state, learnEvents: [] };
    case "notificationUnread":
      return { ...state, notificationUnread: Math.max(action.count, 0) };
    case "notificationUnreadAdd":
      return { ...state, notificationUnread: Math.max(state.notificationUnread + action.delta, 0) };
    case "notificationsRead": {
      const ids = action.ids ? new Set(action.ids) : null;
      let newlyRead = 0;
      const notifications = state.notifications.map((item) => {
        if (item.readAt || (ids && !ids.has(item.notificationId ?? ""))) {
          return item;
        }
        newlyRead += 1;
        return { ...item, readAt: action.readAt };
      });
      return {
        ...state,
        notifications,
        notificationUnread:
          action.unreadCount ?? Math.max(state.notificationUnread - newlyRead, 0)
      };
    }
    case "matchReplay":
      return { ...state, matchReplay: action.replay };
    case "toast":
      return { ...state, toasts: [...state.toasts.slice(-3), action.toast] };
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    case "prefs":
      return { ...state, prefs: { ...state.prefs, ...action.prefs } };
    default:
      return state;
  }
}

function applyPrivateItems(
  state: ExchangeState,
  channel: PrivateChannel,
  items: unknown[]
): ExchangeState {
  switch (channel) {
    case "orders":
      return { ...state, orders: mergeRecords(state.orders, items as OrderRecord[], (o) => o.orderId) };
    case "trades":
      return { ...state, trades: mergeRecords(state.trades, items as TradeRecord[], (t) => t.tradeId) };
    case "balances":
      return {
        ...state,
        balances: mergeRecords(
          state.balances,
          items as BalanceRecord[],
          (b) => `${b.accountId}:${b.assetCode}`
        )
      };
    case "deposits":
      return {
        ...state,
        deposits: mergeRecords(state.deposits, items as DepositRecord[], (d) => d.depositId)
      };
    case "withdrawals":
      return {
        ...state,
        withdrawals: mergeRecords(state.withdrawals, items as WithdrawalRecord[], (w) => w.withdrawalId)
      };
    case "notifications":
      return {
        ...state,
        notifications: mergeRecords(
          state.notifications,
          keepReadMarkers(state.notifications, items as NotificationRecord[]),
          (n) => n.notificationId ?? `${n.eventType}:${n.createdAt}`
        ).slice(0, 50)
      };
    case "account_events":
      return {
        ...state,
        accountEvents: mergeRecords(
          state.accountEvents,
          items as AccountEventRecord[],
          (e) => e.eventKey ?? `${e.entityType}:${e.entityId}:${e.createdAt}`
        ).slice(0, 50)
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface PlaceOrderInput {
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price?: string;
  quantity: string;
  /** Maker-only (GTC limit). */
  postOnly?: boolean;
  /** Self-trade prevention; the engine defaults to expire_taker. */
  stpMode?: StpMode;
  /** stop_limit / stop_market. */
  triggerPrice?: string;
}

export interface WithdrawalInput {
  assetCode: string;
  network: string;
  toAddress: string;
  amount: string;
  fee: string;
  twoFactorCode?: string;
}

function buildActions(
  dispatch: (action: Action) => void,
  stateRef: { current: ExchangeState },
  apiRef: { current: ApiClient | null }
) {
  const api = () => {
    if (!apiRef.current) {
      throw new Error("应用尚未完成初始化");
    }
    return apiRef.current;
  };
  const token = () => stateRef.current.token;
  const toast = (tone: Toast["tone"], title: string, detail?: string) =>
    dispatch({ type: "toast", toast: { id: createIdempotencyKey(), tone, title, detail } });
  const learn = (...events: LearnEvent[]) => dispatch({ type: "learn", events });

  // Rebuilds how the order walked the book from the trades it produced as
  // taker. Failures only hide the replay; the order itself already succeeded.
  async function buildMatchReplay(
    order: OrderRecord,
    input: PlaceOrderInput,
    depthBefore: DepthSnapshot
  ): Promise<void> {
    try {
      let trades: TradeRecord[] = [];
      if (Number(order.filledQuantity ?? "0") > 0) {
        trades = itemsOf<TradeRecord>(
          await api().gateway<unknown>(
            `/trades?orderId=${encodeURIComponent(order.orderId)}&limit=200&offset=0`,
            { token: token() }
          )
        ).filter((trade) => !trade.takerOrderId || trade.takerOrderId === order.orderId);
      }
      const explanation = explainMatch({
        order: {
          side: order.side ?? input.side,
          type: engineTypeOf(order.type ?? input.type),
          timeInForce: order.timeInForce ?? input.timeInForce,
          price: order.price ?? input.price,
          quantity: order.quantity ?? input.quantity,
          filledQuantity: order.filledQuantity,
          status: order.status,
          rejectedReason: order.rejectedReason
        },
        trades,
        depthBefore
      });
      dispatch({
        type: "matchReplay",
        replay: {
          orderId: order.orderId,
          market: order.market ?? stateRef.current.market,
          createdAt: new Date().toISOString(),
          explanation
        }
      });
    } catch {
      dispatch({ type: "matchReplay", replay: null });
    }
  }

  async function refreshUnreadCount(tokenOverride?: string): Promise<void> {
    const currentToken = tokenOverride ?? token();
    if (!currentToken) {
      return;
    }
    try {
      const result = await api().gateway<{ unreadCount?: number }>("/notifications/unread-count", {
        token: currentToken
      });
      if (typeof result.unreadCount === "number") {
        dispatch({ type: "notificationUnread", count: result.unreadCount });
      }
    } catch {
      // Fall back to counting the loaded page so the bell still means something.
      dispatch({
        type: "notificationUnread",
        count: stateRef.current.notifications.filter((item) => !item.readAt).length
      });
    }
  }

  // `tokenOverride` matters right after login: the new token is dispatched but
  // stateRef only catches up on the next render.
  async function refreshAccount(tokenOverride?: string): Promise<void> {
    const currentToken = tokenOverride ?? token();
    if (!currentToken) {
      return;
    }
    dispatch({ type: "accountLoading", loading: true });
    const client = api();
    const auth = { token: currentToken };
    const optional = async <T,>(path: string): Promise<T[]> => {
      try {
        return itemsOf<T>(await client.gateway<unknown>(path, auth));
      } catch {
        return [];
      }
    };
    const single = async <T,>(path: string): Promise<T | null> => {
      try {
        return await client.gateway<T>(path, auth);
      } catch {
        return null;
      }
    };
    try {
      const session = await client.gateway<SessionInfo>("/auth/me", auth);
      const spotAccount = await client
        .gateway<{ accountId: string }>("/accounts/spot", auth)
        .catch(() => null);
      const [balances, orders, trades, depositAddresses, deposits, withdrawals, addressBook, notifications, apiKeys] =
        await Promise.all([
          optional<BalanceRecord>("/balances?limit=100&offset=0"),
          optional<OrderRecord>("/orders?limit=100&offset=0"),
          optional<TradeRecord>("/trades?limit=100&offset=0"),
          optional<DepositAddressRecord>("/deposit-addresses?limit=50&offset=0"),
          optional<DepositRecord>("/deposits?limit=50&offset=0"),
          optional<WithdrawalRecord>("/withdrawals?limit=50&offset=0"),
          optional<AddressBookEntry>("/withdrawal-address-book?limit=50&offset=0"),
          optional<NotificationRecord>("/notifications?limit=50&offset=0"),
          optional<ApiKeyRecord>("/auth/api-keys")
        ]);
      const [twoFactor, kyc, withdrawalLimits] = await Promise.all([
        single<TwoFactorStatus>("/auth/two-factor"),
        single<KycProfile>("/auth/kyc"),
        single<WithdrawalLimits>("/withdrawals/limits")
      ]);
      dispatch({
        type: "accountSnapshot",
        snapshot: {
          session,
          spotAccountId: spotAccount?.accountId ?? spotAccountIdOf(balances),
          balances,
          orders,
          trades,
          depositAddresses,
          deposits,
          withdrawals,
          addressBook,
          notifications,
          apiKeys,
          twoFactor,
          kyc,
          withdrawalLimits
        }
      });
      await refreshUnreadCount(currentToken);
    } catch (error) {
      dispatch({ type: "accountLoading", loading: false });
      if ((error as { status?: number }).status === 401) {
        writeStorage(SIGNED_IN_KEY, null);
        dispatch({ type: "loggedOut" });
        toast("neutral", "登录已过期", "请重新登录");
        return;
      }
      toast("negative", "账户数据加载失败", readErrorMessage(error));
    }
  }

  const actions = {
    toast,
    dismissToast: (id: string) => dispatch({ type: "dismissToast", id }),
    selectMarket: (market: string) => dispatch({ type: "selectMarket", market }),
    setPrefs: (prefs: Partial<Preferences>) => dispatch({ type: "prefs", prefs }),
    clearLearn: () => dispatch({ type: "clearLearn" }),
    refreshAccount,
    refreshUnreadCount,

    /** M4-2: persist the read marker server-side (wallet-service), optimistic locally. */
    async markNotificationRead(notificationId: string) {
      const readAt = new Date().toISOString();
      dispatch({ type: "notificationsRead", ids: [notificationId], readAt });
      try {
        const result = await api().gateway<{ unreadCount?: number }>(
          `/notifications/${encodeURIComponent(notificationId)}/read`,
          { method: "POST", token: token(), body: {} }
        );
        if (typeof result.unreadCount === "number") {
          dispatch({ type: "notificationUnread", count: result.unreadCount });
        }
      } catch (error) {
        toast("negative", "标记已读失败", readErrorMessage(error));
        void refreshUnreadCount();
      }
    },

    async markAllNotificationsRead() {
      const readAt = new Date().toISOString();
      dispatch({ type: "notificationsRead", readAt, unreadCount: 0 });
      try {
        const result = await api().gateway<{ unreadCount?: number }>("/notifications/read-all", {
          method: "POST",
          token: token(),
          body: {}
        });
        if (typeof result.unreadCount === "number") {
          dispatch({ type: "notificationUnread", count: result.unreadCount });
        }
      } catch (error) {
        toast("negative", "全部标记已读失败", readErrorMessage(error));
        void refreshUnreadCount();
      }
    },

    async register(input: { displayName: string; email: string; password: string }) {
      learn(learnEvent({ service: "api-gateway", title: "POST /auth/register", detail: "网关把注册请求转发给 identity-service 创建用户与现货账户。" }));
      await api().gateway("/auth/register", { method: "POST", body: input });
      toast("positive", "注册成功", "请使用新账户登录");
    },

    async login(input: { email: string; password: string; twoFactorCode?: string }) {
      learn(learnEvent({ service: "identity-service", title: "POST /api/session → /auth/sessions", detail: "校验密码（以及可选的 TOTP 二次验证码）签发 Session Token；trader-web 的 Web Host 把它放进 HttpOnly Cookie，页面脚本读不到。" }));
      const result = await fetchJson<SessionInfo & { device?: SessionDevice }>("/api/session", {
        method: "POST",
        body: { ...input, twoFactorCode: input.twoFactorCode || undefined, deviceId: getDeviceId() }
      });
      if (result.device?.isNewDevice) {
        learn(learnEvent({ service: "identity-service", title: "新设备登录", detail: `identity-service 第一次见到设备 ${result.device.deviceLabel}，记录登录事件并通过 wallet-service 站内信提醒；可在账户页「设备管理」退出该设备。` }));
      }
      writeStorage(SIGNED_IN_KEY, "1");
      writeStorage(SEQUENCE_KEY, null);
      dispatch({ type: "sequence", sequence: 0 });
      dispatch({ type: "loggedIn", token: COOKIE_SESSION, session: result });
      toast(
        "positive",
        `欢迎回来，${result.displayName ?? result.email ?? ""}`,
        result.device?.isNewDevice ? "检测到新设备登录，已发送站内通知" : undefined
      );
      await refreshAccount(COOKIE_SESSION);
    },

    async logout() {
      try {
        // Revokes the session at the gateway and clears the HttpOnly cookie.
        await fetchJson("/api/session/logout", { method: "POST", body: {} });
      } catch {
        // The local session is cleared regardless of transport errors.
      }
      writeStorage(SIGNED_IN_KEY, null);
      writeStorage(SEQUENCE_KEY, null);
      dispatch({ type: "loggedOut" });
      toast("neutral", "已退出登录");
    },

    async placeOrder(input: PlaceOrderInput): Promise<OrderRecord> {
      const state = stateRef.current;
      const accountId = state.spotAccountId || spotAccountIdOf(state.balances);
      if (!accountId) {
        throw new Error("未找到现货账户，请先刷新账户数据");
      }
      const idempotencyKey = createIdempotencyKey();
      // Depth just before submission: the book the new order is about to walk.
      const depthBefore = { bids: [...state.depth.bids], asks: [...state.depth.asks] };
      const isStop = isStopType(input.type);
      const isMarketPriced = engineTypeOf(input.type) === "market";
      const body = {
        accountId,
        market: state.market,
        side: input.side,
        type: input.type,
        timeInForce: isMarketPriced ? "ioc" : input.timeInForce,
        price: isMarketPriced ? undefined : input.price,
        quantity: input.quantity,
        idempotencyKey,
        ...(input.postOnly && input.type === "limit" ? { postOnly: true } : {}),
        ...(input.stpMode ? { stpMode: input.stpMode } : {}),
        ...(isStop ? { triggerPrice: input.triggerPrice } : {})
      };
      learn(
        learnEvent({
          service: "api-gateway",
          title: `POST /orders（Idempotency-Key ${idempotencyKey.slice(0, 8)}…）`,
          detail: "网关校验 Session、限流、账户归属；同一个 Idempotency-Key 重放只会返回第一次的结果。"
        }),
        learnEvent({
          service: "risk-service",
          title: "下单前风控检查",
          detail: isStop
            ? "最小数量、步长；止损单还要检查触发价在参考价偏离范围内，并按触发后的订单计算需冻结的资金。"
            : body.postOnly
              ? "最小数量、步长、价格偏离；只做 Maker 仅允许 GTC 限价单。"
              : "最小数量、步长、价格偏离；并计算需冻结的资金。"
        })
      );
      const order = await api().gateway<OrderRecord>("/orders", {
        method: "POST",
        token: token(),
        body,
        idempotencyKey
      });
      const orderTraceId = takeLastTraceId();
      dispatch({ type: "privateItems", channel: "orders", items: [order] });
      const reasonLabel = describeOrderReason(order.rejectedReason);
      learn(
        learnEvent({
          service: "ledger-service",
          title: `冻结 ${formatAmount(order.lockAmount)} ${order.lockAssetCode ?? ""}`,
          detail: "资金从 available 移到 locked，保证撮合成交后一定能结算。"
        }),
        order.status === "pending_trigger"
          ? learnEvent({
              service: "order-service",
              title: `止损单待触发：触发价 ${formatAmount(order.triggerPrice)}`,
              detail: `订单以 pending_trigger 状态保存在数据库，不进入订单簿；StopOrderTriggerWorker 盯着最新成交价，${input.side === "buy" ? "价格 ≥ 触发价" : "价格 ≤ 触发价"} 时把它按${input.type === "stop_limit" ? "限价" : "市价"}单提交给撮合引擎。触发前撤单会解冻全部资金。`,
              traceId: orderTraceId
            })
          : learnEvent({
              service: "matching-engine",
              title: `订单进入撮合：${order.status === "filled" ? "立即全部成交" : order.status === "partially_filled" ? "部分成交" : order.status === "rejected" ? "被拒绝" : order.status === "cancelled" ? "部分成交后剩余过期" : "挂入订单簿"}`,
              detail: [
                body.postOnly ? "只做 Maker：若到达时会与对手盘成交，引擎整单拒绝，不吃单。" : null,
                "自成交保护（STP）：引擎带着账户 ID 撮合，同一账户的买卖单不会互相成交（默认 expire_taker：保留挂单，新订单剩余部分过期）。",
                reasonLabel ? `结果：${reasonLabel}` : null
              ]
                .filter(Boolean)
                .join(" "),
              tone: order.status === "rejected" ? "negative" : "positive",
              traceId: orderTraceId
            })
      );
      if (stateRef.current.prefs.learnMode && order.status !== "pending_trigger") {
        void buildMatchReplay(order, input, depthBefore);
      }
      const sideLabel = input.side === "buy" ? "买入" : "卖出";
      if (order.status === "rejected") {
        toast("negative", "委托被拒绝", reasonLabel);
      } else if (order.status === "pending_trigger") {
        toast(
          "positive",
          `止损${sideLabel}委托已提交`,
          `${formatAmount(order.quantity)} ${marketLabel(order.market ?? state.market)} · 待触发（触发价 ${formatAmount(order.triggerPrice)}）`
        );
      } else {
        toast(
          "positive",
          `${sideLabel}委托已提交`,
          `${formatAmount(order.quantity)} ${marketLabel(order.market ?? state.market)} · ${order.status === "filled" ? "已全部成交" : order.status === "partially_filled" ? "部分成交" : "挂单中"}`
        );
      }
      return order;
    },

    dismissMatchReplay() {
      dispatch({ type: "matchReplay", replay: null });
    },

    /** M3-3: masked ledger journals of one of the user's trades. */
    loadTradeJournals(tradeId: string): Promise<TradeJournalView> {
      return fetchTradeJournals(api(), token(), tradeId);
    },

    async cancelOrder(orderId: string) {
      learn(learnEvent({ service: "order-service", title: "POST /orders/:id/cancel", detail: "撮合引擎移除剩余数量，账本解冻对应资金。" }));
      const order = await api().gateway<OrderRecord>(`/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: "POST",
        token: token(),
        body: {}
      });
      dispatch({ type: "privateItems", channel: "orders", items: [order] });
      toast("neutral", "委托已撤销");
    },

    async cancelAll(market?: string) {
      const open = stateRef.current.orders.filter(
        (order) => isOpenOrder(order) && (!market || order.market === market)
      );
      const results = await Promise.allSettled(
        open.map((order) =>
          api().gateway<OrderRecord>(`/orders/${encodeURIComponent(order.orderId)}/cancel`, {
            method: "POST",
            token: token(),
            body: {}
          })
        )
      );
      const cancelled = results
        .filter((result): result is PromiseFulfilledResult<OrderRecord> => result.status === "fulfilled")
        .map((result) => result.value);
      dispatch({ type: "privateItems", channel: "orders", items: cancelled });
      toast(cancelled.length === open.length ? "neutral" : "negative", `已撤销 ${cancelled.length}/${open.length} 笔委托`);
    },

    async createDepositAddress(assetCode: string, network: string) {
      const ledgerAccountId = stateRef.current.spotAccountId || spotAccountIdOf(stateRef.current.balances);
      const address = await api().gateway<DepositAddressRecord>("/deposit-addresses", {
        method: "POST",
        token: token(),
        body: { ledgerAccountId, assetCode, network },
        idempotencyKey: createIdempotencyKey()
      });
      dispatch({
        type: "accountSnapshot",
        snapshot: {
          depositAddresses: [address, ...stateRef.current.depositAddresses]
        }
      });
      return address;
    },

    async requestFaucet(assetCode: string, amount: string): Promise<FaucetReceipt> {
      learn(
        learnEvent({
          service: "demo-simulator",
          title: `模拟链上转入 ${amount} ${assetCode}`,
          detail: "模拟器把一笔转账打包进新区块，并报告给 blockchain-indexer。"
        })
      );
      const receipt = await api().demo<FaucetReceipt>("/faucet", {
        method: "POST",
        token: token(),
        body: { assetCode, amount }
      });
      learn(
        learnEvent({
          service: "blockchain-indexer",
          title: `检测到充值交易，等待 ${receipt.requiredConfirmations} 个确认`,
          detail: "确认数随新区块增加；达到阈值后才通知 wallet-service 入账，以防链重组。"
        })
      );
      return receipt;
    },

    async validateWithdrawal(input: WithdrawalInput) {
      return api().gateway<Record<string, unknown>>("/withdrawals/validate", {
        method: "POST",
        token: token(),
        body: { ...input, ledgerAccountId: stateRef.current.spotAccountId || spotAccountIdOf(stateRef.current.balances) }
      });
    },

    async requestWithdrawal(input: WithdrawalInput) {
      learn(
        learnEvent({
          service: "wallet-service",
          title: `提现申请 ${input.amount} ${input.assetCode}`,
          detail: "先做 KYT 地址风险评分（黑名单直接拦截、混币等高风险需双人复核），再校验白名单、限额和 2FA；通过后在账本中冻结 金额+手续费，进入人工审核队列。"
        })
      );
      const withdrawal = await api().gateway<WithdrawalRecord>("/withdrawals/request", {
        method: "POST",
        token: token(),
        body: { ...input, ledgerAccountId: stateRef.current.spotAccountId || spotAccountIdOf(stateRef.current.balances) },
        idempotencyKey: createIdempotencyKey()
      });
      const withdrawalTraceId = takeLastTraceId();
      dispatch({ type: "privateItems", channel: "withdrawals", items: [withdrawal] });
      if (withdrawalTraceId) {
        learn(
          learnEvent({
            service: "ledger-service",
            title: `冻结 ${input.amount} ${input.assetCode} + 手续费，等待审核`,
            traceId: withdrawalTraceId
          })
        );
      }
      toast("positive", "提现申请已提交", "等待运营后台审核");
      void actions.refreshSecurity();
      return withdrawal;
    },

    async addAddressBookEntry(input: { network: string; address: string; label: string }) {
      const entry = await api().gateway<AddressBookEntry>("/withdrawal-address-book", {
        method: "POST",
        token: token(),
        body: input,
        idempotencyKey: createIdempotencyKey()
      });
      dispatch({
        type: "accountSnapshot",
        snapshot: { addressBook: [entry, ...stateRef.current.addressBook] }
      });
      toast("positive", "地址已保存", entry.isWhitelisted ? "已加入白名单" : "白名单需运营审核开启");
      // A new address may start the withdrawal cooldown (M5-2).
      void actions.refreshSecurity();
      return entry;
    },

    async createApiKey(label: string, scopes?: ApiKeyScope[]): Promise<ApiKeyRecord> {
      const key = await api().gateway<ApiKeyRecord>("/auth/api-keys", {
        method: "POST",
        token: token(),
        body: { label, scopes },
        idempotencyKey: createIdempotencyKey()
      });
      dispatch({ type: "accountSnapshot", snapshot: { apiKeys: [key, ...stateRef.current.apiKeys] } });
      return key;
    },

    /** Re-reads 2FA, KYC and withdrawal limits after a security change. */
    async refreshSecurity() {
      const auth = { token: token() };
      const read = async <T,>(path: string): Promise<T | null> => {
        try {
          return await api().gateway<T>(path, auth);
        } catch {
          return null;
        }
      };
      const [twoFactor, kyc, withdrawalLimits] = await Promise.all([
        read<TwoFactorStatus>("/auth/two-factor"),
        read<KycProfile>("/auth/kyc"),
        read<WithdrawalLimits>("/withdrawals/limits")
      ]);
      dispatch({ type: "accountSnapshot", snapshot: { twoFactor, kyc, withdrawalLimits } });
    },

    // M4-1: self-service TOTP 2FA. identity-service owns the secret; the QR
    // code is rendered client-side from the otpauth URI.
    async enrollTwoFactor(): Promise<TwoFactorEnrollment> {
      learn(learnEvent({ service: "identity-service", title: "POST /auth/two-factor/enroll", detail: "生成新的 TOTP 密钥（待验证状态），返回 otpauth:// URI 供身份验证器扫码。" }));
      return api().gateway<TwoFactorEnrollment>("/auth/two-factor/enroll", { method: "POST", token: token(), body: {} });
    },

    async enableTwoFactor(code: string): Promise<TwoFactorStatus> {
      const status = await api().gateway<TwoFactorStatus>("/auth/two-factor/enable", {
        method: "POST",
        token: token(),
        body: { code }
      });
      learn(learnEvent({ service: "identity-service", title: "2FA 已开启", detail: "首个动态码校验通过后才正式启用；同时生成一次性恢复码（只保存哈希）。之后登录与提现都需要动态码。" }));
      toast("positive", "二次验证已开启", "请妥善保存恢复码");
      await actions.refreshSecurity();
      return status;
    },

    async disableTwoFactor(code: string): Promise<TwoFactorStatus> {
      const status = await api().gateway<TwoFactorStatus>("/auth/two-factor/disable", {
        method: "POST",
        token: token(),
        body: { code }
      });
      toast("neutral", "二次验证已关闭", "修改 2FA 后可能进入提现冷却期");
      await actions.refreshSecurity();
      return status;
    },

    async regenerateRecoveryCodes(code: string): Promise<TwoFactorStatus> {
      const status = await api().gateway<TwoFactorStatus>("/auth/two-factor/recovery-codes", {
        method: "POST",
        token: token(),
        body: { code }
      });
      await actions.refreshSecurity();
      return status;
    },

    // M4-4: KYC (demo fields only).
    async submitKyc(input: { requestedTier: "L1" | "L2"; fullName: string; idNumber: string }) {
      await api().gateway("/auth/kyc/requests", { method: "POST", token: token(), body: input });
      toast("positive", "认证申请已提交", "等待运营后台审核");
      await actions.refreshSecurity();
    },

    async revokeApiKey(apiKeyId: string) {
      await api().gateway(`/auth/api-keys/${encodeURIComponent(apiKeyId)}/revoke`, {
        method: "POST",
        token: token(),
        body: {}
      });
      await refreshAccount();
      toast("neutral", "API Key 已吊销");
    }
  };
  return actions;
}

export type ExchangeActions = ReturnType<typeof buildActions>;

interface ExchangeContextValue {
  state: ExchangeState;
  actions: ExchangeActions;
  api: ApiClient | null;
  marketDefinition: MarketDefinition | undefined;
  assets: AssetBalance[];
}

const ExchangeContext = createContext<ExchangeContextValue | null>(null);

export function ExchangeProvider(props: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const apiRef = useRef<ApiClient | null>(null);
  const publicSocketRef = useRef<ManagedSocket | null>(null);
  const privateSocketRef = useRef<ManagedSocket | null>(null);

  const actions = useMemo(() => buildActions(dispatch, stateRef, apiRef), []);

  // Boot: runtime config -> public market snapshot.
  useEffect(() => {
    let disposed = false;
    writeStorage(LEGACY_TOKEN_KEY, null);
    fetchConfig()
      .then((config) => {
        if (disposed) {
          return;
        }
        apiRef.current = createApiClient(config);
        dispatch({ type: "booted", config });
      })
      .catch((error) => dispatch({ type: "bootFailed", error: readErrorMessage(error) }));
    return () => {
      disposed = true;
    };
  }, []);

  // Persist preferences and apply theme.
  useEffect(() => {
    writeStorage(PREFS_KEY, JSON.stringify(state.prefs));
    document.documentElement.dataset.theme = state.prefs.theme;
  }, [state.prefs]);

  // Ticker list for every market (the public socket only follows one market).
  useEffect(() => {
    if (!state.config) {
      return;
    }
    const load = () =>
      apiRef.current
        ?.market<MarketTicker[]>("/tickers")
        .then((tickers) => dispatch({ type: "tickers", tickers: Array.isArray(tickers) ? tickers : [] }))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [state.config]);

  // REST snapshot for the selected market (also the fallback when the socket is down).
  const loadMarketSnapshot = useCallback(async (market: string) => {
    const api = apiRef.current;
    if (!api) {
      return;
    }
    const query = `market=${encodeURIComponent(market)}`;
    const [depth, trades] = await Promise.all([
      api.market<DepthSnapshot>(`/depth?${query}&limit=20`).catch(() => null),
      api.market<TradeRecord[]>(`/trades?${query}&limit=50`).catch(() => null)
    ]);
    if (stateRef.current.market !== market) {
      return;
    }
    if (depth) {
      dispatch({ type: "depth", depth: { ...depth, market } });
    }
    if (Array.isArray(trades)) {
      dispatch({ type: "publicTrades", trades });
    }
  }, []);

  // Public market-data socket.
  useEffect(() => {
    const config = state.config;
    if (!config) {
      return;
    }
    const subscribe = (socket: ManagedSocket) =>
      socket.send({
        type: "subscribe",
        market: stateRef.current.market,
        channels: ["ticker", "depth", "trades"]
      });
    const socket = new ManagedSocket({
      url: config.marketDataWsUrl,
      onStatus: (status) => dispatch({ type: "publicFeed", status }),
      onOpen: (current) => {
        dispatch({ type: "publicFeed", status: "live" });
        subscribe(current);
      },
      onMessage: (raw, current) => {
        const message = raw as PublicRealtimeMessage;
        if (message.type === "ready") {
          subscribe(current);
          return;
        }
        if (message.market && message.market !== stateRef.current.market) {
          return;
        }
        if (message.channel === "ticker" && message.item) {
          dispatch({ type: "tickers", tickers: [message.item as MarketTicker] });
        } else if (message.channel === "depth" && message.item) {
          dispatch({ type: "depth", depth: message.item as DepthSnapshot });
        } else if (message.channel === "trades" && Array.isArray(message.items)) {
          dispatch({ type: "publicTrades", trades: message.items });
        }
      }
    });
    publicSocketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      publicSocketRef.current = null;
    };
  }, [state.config]);

  // Market switch: REST snapshot + resubscribe both feeds.
  useEffect(() => {
    if (!state.config) {
      return;
    }
    void loadMarketSnapshot(state.market);
    publicSocketRef.current?.send({
      type: "subscribe",
      market: state.market,
      channels: ["ticker", "depth", "trades"]
    });
    privateSocketRef.current?.send({ type: "subscribe", market: state.market, channels: PRIVATE_CHANNELS });
  }, [state.config, state.market, loadMarketSnapshot]);

  // Account snapshot after boot when a token is already stored.
  useEffect(() => {
    if (state.config && state.token && !state.session) {
      void actions.refreshAccount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.config, state.token]);

  // Private gateway socket (auth -> subscribe -> resume from last sequence).
  useEffect(() => {
    const config = state.config;
    const token = state.token;
    if (!config || !token) {
      return;
    }
    // The Web Host proxies the private socket and authenticates the upgrade
    // with the session cookie, so no token is sent from the page.
    const viaWebHost = token === COOKIE_SESSION && Boolean(config.privateWsPath);
    const socket = new ManagedSocket({
      url: viaWebHost
        ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${config.privateWsPath}`
        : config.gatewayWsUrl,
      onStatus: (status) => dispatch({ type: "privateFeed", status }),
      onOpen: (current) => {
        if (!viaWebHost) {
          current.send({ type: "auth", token });
        }
      },
      onMessage: (raw, current) => handlePrivateMessage(raw as PrivateRealtimeMessage, current),
      // The gateway ends private sockets whose session expired (4001) or was
      // revoked (4003); reconnecting with the same token would only fail again.
      onServerClose: (code) => {
        if (code !== 4001 && code !== 4003) {
          return false;
        }
        writeStorage(SIGNED_IN_KEY, null);
        dispatch({ type: "loggedOut" });
        actions.toast("neutral", code === 4001 ? "登录已过期" : "会话已失效", "请重新登录");
        return true;
      }
    });

    const handlePrivateMessage = (message: PrivateRealtimeMessage, current: ManagedSocket) => {
      if (typeof message.sequence === "number" && message.sequence > 0) {
        writeStorage(SEQUENCE_KEY, String(message.sequence));
        dispatch({ type: "sequence", sequence: message.sequence });
      }
      switch (message.type) {
        case "authenticated": {
          dispatch({ type: "privateFeed", status: "live" });
          current.send({ type: "subscribe", market: stateRef.current.market, channels: PRIVATE_CHANNELS });
          const lastSequence = stateRef.current.lastSequence;
          if (lastSequence > 0) {
            current.send({
              type: "resume",
              lastSequence,
              market: stateRef.current.market,
              channels: PRIVATE_CHANNELS
            });
          }
          dispatch({
            type: "learn",
            events: [
              learnEvent({
                service: "api-gateway",
                title: lastSequence > 0 ? `私有推送已重连，从序号 ${lastSequence} 续传` : "私有推送已认证并订阅",
                detail: "断线重连时客户端带上最后收到的 sequence，网关补发缺失事件；缓冲区不够时要求客户端重新拉快照（resync）。"
              })
            ]
          });
          return;
        }
        case "resync_required":
          dispatch({
            type: "learn",
            events: [learnEvent({ service: "api-gateway", title: "需要重新同步（resync）", detail: "缺失的事件已不在网关缓冲区，客户端重新拉取 REST 快照。" })]
          });
          void actions.refreshAccount();
          return;
        case "error":
          if (/auth|token|session/i.test(message.message ?? "")) {
            current.close();
          }
          return;
        case "snapshot":
        case "event": {
          if (!message.channel || !Array.isArray(message.items) || message.items.length === 0) {
            return;
          }
          if (message.channel === "notifications") {
            if (message.type === "event") {
              const fresh = countNewUnread(
                stateRef.current.notifications,
                message.items as NotificationRecord[]
              );
              if (fresh > 0) {
                dispatch({ type: "notificationUnreadAdd", delta: fresh });
              }
            } else {
              // A (re)subscribe snapshot may hide events missed while offline.
              void actions.refreshUnreadCount();
            }
          }
          if (message.type === "event") {
            notifyTransitions(message.channel, message.items);
            dispatch({ type: "learn", events: explainPrivateItems(message.channel, message.items) });
          }
          dispatch({ type: "privateItems", channel: message.channel, items: message.items });
          return;
        }
        default:
          return;
      }
    };

    // Toast on meaningful state transitions (order filled, deposit credited...).
    const notifyTransitions = (channel: PrivateChannel, items: unknown[]) => {
      const current = stateRef.current;
      if (channel === "orders") {
        for (const order of items as OrderRecord[]) {
          const previous = current.orders.find((item) => item.orderId === order.orderId);
          if (previous && previous.status !== order.status && order.status === "filled") {
            actions.toast(
              "positive",
              `${order.side === "sell" ? "卖出" : "买入"}订单已完全成交`,
              `${formatAmount(order.quantity)} ${marketLabel(order.market ?? "")} @ ${formatAmount(order.price, 2)}`
            );
          }
        }
      } else if (channel === "deposits") {
        for (const deposit of items as DepositRecord[]) {
          const previous = current.deposits.find((item) => item.depositId === deposit.depositId);
          if (deposit.status === "credited" && previous?.status !== "credited") {
            actions.toast("positive", "充值已到账", `${formatAmount(deposit.amount)} ${deposit.assetCode ?? ""}`);
          }
        }
      } else if (channel === "withdrawals") {
        for (const withdrawal of items as WithdrawalRecord[]) {
          const previous = current.withdrawals.find((item) => item.withdrawalId === withdrawal.withdrawalId);
          if (previous && previous.status !== withdrawal.status) {
            const status = describeFundingStatus(withdrawal.status, "withdrawal");
            actions.toast(
              status.tone === "negative" ? "negative" : status.tone === "positive" ? "positive" : "neutral",
              `提现${status.label}`,
              `${formatAmount(withdrawal.amount)} ${withdrawal.assetCode ?? ""}`
            );
          }
        }
      }
    };

    privateSocketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      privateSocketRef.current = null;
    };
  }, [state.config, state.token, actions]);

  const marketDefinition = state.config?.markets.find((item) => item.market === state.market);
  const assets = useMemo(
    () => summarizeBalances(state.balances, state.config?.assets.map((asset) => asset.code)),
    [state.balances, state.config]
  );

  const value = useMemo<ExchangeContextValue>(
    () => ({ state, actions, api: apiRef.current, marketDefinition, assets }),
    [state, actions, marketDefinition, assets]
  );

  return <ExchangeContext.Provider value={value}>{props.children}</ExchangeContext.Provider>;
}

export function useExchange(): ExchangeContextValue {
  const value = useContext(ExchangeContext);
  if (!value) {
    throw new Error("useExchange must be used inside <ExchangeProvider>");
  }
  return value;
}
