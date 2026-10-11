// Guided scenarios (M3-5). Pure definitions: each step says where to go, what
// to highlight and how to tell it is done from the exchange state, so a new
// user can follow a scenario without reading the docs. The panel component
// renders them; tests exercise the completion rules directly.

export interface TourSnapshot {
  loggedIn: boolean;
  page: string;
  orders: Array<{ orderId: string; status?: string; createdAt?: string }>;
  trades: Array<{ tradeId: string; settlementId?: string; executedAt?: string }>;
  deposits: Array<{ depositId: string; status?: string; confirmations?: number; createdAt?: string; detectedAt?: string }>;
  withdrawals: Array<{ withdrawalId: string; status?: string; reviewStatus?: string; requestedAt?: string; createdAt?: string }>;
}

/**
 * When the tour started. Only activity after it counts as "new": the user may
 * start a tour logged out, and the account's history only arrives after login.
 */
export interface TourBaseline {
  startedAt: string;
}

// Browser and services share the local clock; allow a little skew anyway.
const CLOCK_SKEW_MS = 5_000;

function isNew(timestamp: string | undefined, baseline: TourBaseline): boolean {
  if (!timestamp) {
    return false;
  }
  return new Date(timestamp).getTime() >= new Date(baseline.startedAt).getTime() - CLOCK_SKEW_MS;
}

export interface TourContext {
  snapshot: TourSnapshot;
  baseline: TourBaseline;
}

export interface TourLink {
  label: string;
  /** In-app hash path, e.g. "/trade/ETH-USDT". */
  path?: string;
  /** External page (ops-console); `{ops}` is replaced with the ops-console URL. */
  external?: string;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector to outline while this step is active. */
  target?: string;
  link?: TourLink;
  /** Automatic completion rule; steps without one are confirmed by the user. */
  done?: (context: TourContext) => boolean;
}

export interface TourDefinition {
  id: string;
  title: string;
  summary: string;
  steps: TourStep[];
}

const newOrders = (context: TourContext) =>
  context.snapshot.orders.filter((order) => isNew(order.createdAt, context.baseline));
const newTrades = (context: TourContext) =>
  context.snapshot.trades.filter((trade) => isNew(trade.executedAt, context.baseline));
const newDeposits = (context: TourContext) =>
  context.snapshot.deposits.filter((deposit) => isNew(deposit.detectedAt ?? deposit.createdAt, context.baseline));
const newWithdrawals = (context: TourContext) =>
  context.snapshot.withdrawals.filter((withdrawal) =>
    isNew(withdrawal.requestedAt ?? withdrawal.createdAt, context.baseline)
  );

const APPROVED_WITHDRAWAL = ["approved", "broadcasted", "broadcasting", "confirmed", "completed"];

const loginStep: TourStep = {
  id: "login",
  title: "登录演示账户",
  body: "登录页点「⚡ 一键登录演示账户」，用预置的演示账户登录。",
  target: "#demo-login, #hero-login, #login-form",
  link: { label: "去登录", path: "/login" },
  done: ({ snapshot }) => snapshot.loggedIn
};

export const TOURS: TourDefinition[] = [
  {
    id: "first-trade",
    title: "完成第一笔交易",
    summary: "下一笔会立即成交的限价单，看资金冻结、撮合、结算三步。",
    steps: [
      loginStep,
      {
        id: "open-trade",
        title: "打开交易页",
        body: "左侧是订单簿（卖单在上、买单在下），右侧是下单表单。",
        link: { label: "去交易", path: "/trade" },
        done: ({ snapshot }) => snapshot.page === "trade"
      },
      {
        id: "place-order",
        title: "下一笔买单",
        body: "点订单簿里最低的卖价自动填入价格，数量填 0.01，点「买入」。开启学习模式可以看到每个服务做了什么。",
        target: "#order-form",
        done: (context) => newOrders(context).length > 0
      },
      {
        id: "get-fill",
        title: "等待成交",
        body: "价格不低于最优卖价的买单会立即吃掉卖单，成交记录出现在页面下方。",
        target: "#trade-history-table, #recent-trades",
        done: (context) => newTrades(context).length > 0
      },
      {
        id: "settled",
        title: "看结算完成",
        body: "结算服务把冻结的 USDT 换成 ETH 并扣手续费。点成交记录里的「T 型账户」看每一笔分录，借贷必然相等。",
        target: "#trade-history-table",
        done: (context) => newTrades(context).some((trade) => Boolean(trade.settlementId))
      }
    ]
  },
  {
    id: "deposit",
    title: "充值并观察确认数",
    summary: "从模拟链领取测试币，看区块确认数增长到阈值后才入账。",
    steps: [
      loginStep,
      {
        id: "open-deposit",
        title: "打开充值面板",
        body: "资产页选择「充值」，系统会为你分配一个链上充值地址，下方就是测试水龙头。",
        target: "#deposit-panel",
        link: { label: "去充值", path: "/assets?action=deposit" },
        done: ({ snapshot }) => snapshot.page === "assets"
      },
      {
        id: "faucet",
        title: "模拟转入测试币",
        body: "在「🚰 测试水龙头」里点「模拟转入」，模拟器把一笔转账打包进新区块，indexer 立刻发现它。",
        target: "#faucet-submit",
        done: (context) => newDeposits(context).length > 0
      },
      {
        id: "confirming",
        title: "等待区块确认",
        body: "确认数随新区块增加。到达阈值前资金不会入账，以防链重组把交易回滚。",
        target: "#deposits-table",
        done: (context) =>
          newDeposits(context).some((deposit) => (deposit.confirmations ?? 0) > 0 || deposit.status === "credited")
      },
      {
        id: "credited",
        title: "充值入账",
        body: "达到确认阈值后 wallet-service 记一笔分录，余额增加，铃铛里会收到到账通知。",
        target: "#balances-table",
        done: (context) => newDeposits(context).some((deposit) => deposit.status === "credited")
      }
    ]
  },
  {
    id: "withdrawal",
    title: "提现并在运营后台审核",
    summary: "提交提现，资金先冻结；运营人员在后台批准后才广播上链。",
    steps: [
      loginStep,
      {
        id: "open-withdraw",
        title: "打开提现面板",
        body: "提现地址需在地址簿中并加入白名单；演示账户已预置。",
        target: "#withdraw-panel",
        link: { label: "去提现", path: "/assets?action=withdraw" },
        done: ({ snapshot }) => snapshot.page === "assets"
      },
      {
        id: "request",
        title: "提交提现申请",
        body: "填写数量后提交。账本冻结 金额 + 手续费，申请进入人工审核队列。",
        target: "#withdraw-submit",
        done: (context) => newWithdrawals(context).length > 0
      },
      {
        id: "approve",
        title: "在运营后台批准",
        body: "打开运营后台（ops-console），在「提现审核」里批准这笔申请。",
        link: { label: "打开运营后台", external: "{ops}/#/withdrawals" },
        done: (context) =>
          newWithdrawals(context).some((withdrawal) =>
            APPROVED_WITHDRAWAL.includes(withdrawal.status ?? "") || withdrawal.reviewStatus === "approved"
          )
      },
      {
        id: "confirmed",
        title: "链上确认",
        body: "托管通道广播交易，确认后账本消耗冻结资金，提现完成。",
        target: "#withdrawals-table",
        done: (context) => newWithdrawals(context).some((withdrawal) => withdrawal.status === "confirmed")
      }
    ]
  },
  {
    id: "settlement-incident",
    title: "排查一次结算异常",
    summary: "在故障实验室暂停结算消费者，观察「已成交未结算」，再恢复。",
    steps: [
      loginStep,
      {
        id: "pause",
        title: "暂停结算消费者",
        body: "运营后台 → 系统运维 → 实验室，点「暂停结算消费」。之后的成交只会停在撮合层。",
        link: { label: "打开实验室", external: "{ops}/#/system?tab=lab" }
      },
      {
        id: "trade-unsettled",
        title: "制造一笔已成交未结算",
        body: "回到交易页下一笔立即成交的单。成交出现了，但打开它的「T 型账户」会显示「结算中」，冻结资金也没有释放。",
        link: { label: "去交易", path: "/trade" },
        done: (context) => newTrades(context).length > 0
      },
      {
        id: "observe",
        title: "定位问题",
        body: "在实验室看结算消费者的滞后（lag）在增长；运营总览的告警和结算报表里「待恢复」数量也会变化。",
        link: { label: "打开实验室", external: "{ops}/#/system?tab=lab" }
      },
      {
        id: "resume",
        title: "恢复并核对",
        body: "点「恢复消费」，消费者从检查点补齐积压的成交；再到「账本」页确认对账一致。",
        done: (context) => {
          const trades = newTrades(context);
          return trades.length > 0 && trades.every((trade) => Boolean(trade.settlementId));
        }
      }
    ]
  }
];

export function baselineOf(now: Date = new Date()): TourBaseline {
  return { startedAt: now.toISOString() };
}

/**
 * Index of the first unfinished step. Automatic rules are re-evaluated every
 * time; manually confirmed steps stay done. Steps never go "back" past a step
 * the user already got through.
 */
export function currentStepIndex(
  tour: TourDefinition,
  context: TourContext,
  confirmed: string[],
  reached: number
): number {
  let index = Math.max(0, reached);
  while (index < tour.steps.length) {
    const step = tour.steps[index]!;
    const finished = step.done ? step.done(context) : confirmed.includes(step.id);
    if (!finished) {
      break;
    }
    index += 1;
  }
  return index;
}
