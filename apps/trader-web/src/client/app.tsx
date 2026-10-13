import { useEffect } from "react";

import { BootScreen, Toasts, TopNav } from "./components/layout.js";
import { AccountPage } from "./features/account/account-page.js";
import { AssetsPage } from "./features/assets/assets-page.js";
import { ReservesPage } from "./features/assets/reserves-page.js";
import { StatementPage } from "./features/assets/statement-page.js";
import { AuthPage } from "./features/auth/auth-page.js";
import { HomePage } from "./features/home/home-page.js";
import { LearnDrawer } from "./features/learn/learn-drawer.js";
import { OrdersPage } from "./features/orders/orders-page.js";
import { TourPanel } from "./features/tour/tour-panel.js";
import { TradePage } from "./features/trade/trade-page.js";
import { useRoute, type Route } from "./lib/router.js";
import { ExchangeProvider, useExchange } from "./state/store.js";

export function App() {
  return (
    <ExchangeProvider>
      <Shell />
    </ExchangeProvider>
  );
}

function Shell() {
  const { state } = useExchange();
  const route = useRoute();

  // The trade page shows the live price in the tab title; other pages use a static title.
  useEffect(() => {
    if (route.page !== "trade") {
      document.title = `${PAGE_TITLES[route.page] ?? ""}${state.config?.appTitle ?? "Web3 CEX"}`;
    }
  }, [route.page, state.config?.appTitle]);

  if (!state.config) {
    return <BootScreen error={state.bootError} />;
  }

  return (
    <div className={state.prefs.learnMode ? "app with-learn" : "app"} data-page={route.page}>
      <TopNav page={route.page} />
      <div className="app-body">
        <main className="app-main">
          <Page route={route} />
        </main>
        <LearnDrawer />
      </div>
      <TourPanel page={route.page} />
      <Toasts />
    </div>
  );
}

const PAGE_TITLES: Partial<Record<Route["page"], string>> = {
  assets: "资产 · ",
  orders: "订单 · ",
  account: "账户 · ",
  login: "登录 · "
};

function Page(props: { route: Route }) {
  const { route } = props;
  switch (route.page) {
    case "trade":
      return <TradePage market={route.params[0]} />;
    case "assets":
      if (route.params[0] === "ledger") {
        return <StatementPage />;
      }
      if (route.params[0] === "reserves") {
        return <ReservesPage />;
      }
      return (
        <AssetsPage
          action={route.query.get("action") ?? undefined}
          asset={route.query.get("asset") ?? undefined}
          tab={route.query.get("tab") ?? undefined}
          highlight={route.query.get("highlight") ?? undefined}
        />
      );
    case "orders":
      return (
        <OrdersPage
          tab={route.query.get("tab") ?? undefined}
          highlight={route.query.get("highlight") ?? undefined}
        />
      );
    case "account":
      return <AccountPage />;
    case "login":
      return (
        <AuthPage
          key={route.query.get("mode") ?? "login"}
          mode={route.query.get("mode") === "register" ? "register" : "login"}
          redirect={route.query.get("redirect") ?? undefined}
        />
      );
    default:
      return <HomePage />;
  }
}
