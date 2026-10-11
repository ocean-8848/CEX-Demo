import { useHashRoute } from "@web3-cex/web-ui";

import { Shell, Toasts, type PageKey } from "./components/layout.js";
import { AuditPage } from "./features/audit-page.js";
import { DashboardPage } from "./features/dashboard-page.js";
import { DepositsPage } from "./features/deposits-page.js";
import { LedgerPage } from "./features/ledger-page.js";
import { LoginPage } from "./features/login-page.js";
import { MarketsPage } from "./features/markets-page.js";
import { SystemPage } from "./features/system-page.js";
import { TracePage } from "./features/trace-page.js";
import { TradingPage } from "./features/trading-page.js";
import { UsersPage } from "./features/users-page.js";
import { WithdrawalsPage } from "./features/withdrawals-page.js";
import { SessionProvider, useSession } from "./state/session.js";

const PAGES: PageKey[] = ["dashboard", "withdrawals", "users", "deposits", "trading", "markets", "trace", "ledger", "system", "audit"];

export function App() {
  return (
    <SessionProvider>
      <Root />
    </SessionProvider>
  );
}

function Root() {
  const { session, booting } = useSession();
  const route = useHashRoute();

  if (booting) {
    return <div className="boot"><span className="brand-mark big">◆</span><p>正在恢复会话…</p></div>;
  }
  if (!session) {
    return (
      <>
        <LoginPage />
        <Toasts />
      </>
    );
  }

  const head = route.segments[0] ?? "dashboard";
  const page = (PAGES as string[]).includes(head) ? (head as PageKey) : "dashboard";
  const param = route.segments[1];

  return (
    <Shell page={page}>
      {page === "dashboard" ? <DashboardPage /> : null}
      {page === "withdrawals" ? <WithdrawalsPage initialId={param} /> : null}
      {page === "users" ? <UsersPage initialUserId={param} /> : null}
      {page === "deposits" ? <DepositsPage /> : null}
      {page === "trading" ? <TradingPage /> : null}
      {page === "markets" ? <MarketsPage /> : null}
      {page === "trace" ? <TracePage query={route.query} /> : null}
      {page === "ledger" ? <LedgerPage /> : null}
      {page === "system" ? <SystemPage /> : null}
      {page === "audit" ? <AuditPage /> : null}
    </Shell>
  );
}
