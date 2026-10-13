# CEX Demo

**English** | [简体中文](README.zh-CN.md)

A runnable, end-to-end **centralized crypto exchange (CEX) demo** plus a structured **learning curriculum** on how real exchanges work. Built for learning: every asset is test data and the chain is a local simulated EVM chain.

The repository has two parts:

| Part | What it is | Start here |
|---|---|---|
| **CEX Demo** | A spot exchange monorepo: trader web app, ops console, API gateway, 10 backend services, a Rust matching engine, and a market-maker / chain simulator. | [Quick start](#quick-start) · [docs/](docs/README.md) |
| **Learning materials** | 13 core chapters, 12 "backstage" topics, 11 product deep dives, 22 interactive labs, and 40 animated slide decks explaining exchange systems. | [learning/](learning/README.md) |

> Most documentation and learning content is written in **Simplified Chinese**. Code, commands and identifiers are in English.

## What the demo covers

- **Spot trading** on `ETH/USDT` (default), `BTC/USDT` and `SOL/USDT`: limit / market / stop-limit / stop-market orders, GTC / IOC / FOK, post-only, self-trade prevention, order book, trades, K-lines; maker / taker fees with VIP tiers by 30-day volume (`config/fee-tiers.json`).
- **Funds**: deposit addresses, a test faucet with confirmation tracking, withdrawals with review, a double-entry ledger with freeze / unfreeze / consume.
- **Accounts & security**: sessions (HttpOnly cookie), self-service 2FA, KYC levels and withdrawal limits, API keys (keyId + secret signing), RBAC, signed service-to-service calls.
- **Operations**: withdrawal review with dual approval for large amounts, KYC review, fee-tier overrides, market halt / resume, market surveillance alerts (wash trading, spoofing, concentrated volume, price moves), ledger reconciliation, business tracing by any ID, audit log, and a fault-injection lab.
- **Learning mode** in the trader app: shows which services each action passes through, replays matching step by step, and links to Jaeger traces.

## Architecture at a glance

```
trader-web ─┐                          ┌─ risk-service
ops-console ┼─ api-gateway / BFF ──────┼─ order-service ── matching-engine (Rust)
            │                          ├─ settlement-service
            │                          ├─ market-data-service
            │                          ├─ identity-service
            │                          ├─ wallet-service ── blockchain-indexer
            │                          ├─ custody-adapter
            │                          └─ ledger-service (double-entry, source of truth)
demo-simulator: market makers + simulated EVM chain + faucet
infra: PostgreSQL · Redis · Kafka · ClickHouse (Docker)
```

Stack: TypeScript + NestJS services, Rust matching engine, React SPAs, PostgreSQL, Redis, Kafka, ClickHouse, optional OpenTelemetry + Jaeger. Details: [docs/architecture.md](docs/architecture.md).

## Quick start

Prerequisites: Node.js 22 (pinned in [.nvmrc](.nvmrc); run `nvm use`), pnpm 10, Rust (stable), Docker. Chrome is only needed for the browser E2E tests.

```bash
pnpm install --frozen-lockfile
pnpm demo:up
```

`demo:up` starts the Docker infrastructure, builds and starts every service (including the simulator), and seeds demo data. Then open:

| App | URL | Login |
|---|---|---|
| Trader web | <http://127.0.0.1:3013> | Click **一键登录演示账户** (one-click demo login), or register and claim test coins from the faucet under **资产** |
| Ops console | <http://127.0.0.1:3006> | `ops-admin@example.com` / `OpsAdminPass123!`, TOTP code from `pnpm -s ops:totp` |
| Ops reviewer (second approver) | <http://127.0.0.1:3006> | `ops-reviewer@example.com` / `OpsReviewerPass123!`, TOTP from `pnpm -s ops:totp reviewer` |

These credentials and TOTP seeds are local demo fixtures only.

Stop with `pnpm stack:stop` (add Docker: `pnpm stack:stop:infra`).

Next steps:

- [docs/getting-started.md](docs/getting-started.md): ports, environment variables, scripts, and tests
- [docs/manual/](docs/manual/README.md): the user manual, covering every page of both apps with screenshots (Chinese)
- [docs/demo-walkthrough.md](docs/demo-walkthrough.md): a guided tour of both apps and the main money flows
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems

## Repository layout

```
apps/          trader-web (user app), ops-console (operations console + BFF)
services/      api-gateway, identity, wallet, blockchain-indexer, custody-adapter,
               ledger, risk, order, settlement, market-data
engines/       matching-engine (Rust)
packages/      domain (shared types & market config), web-ui, telemetry
config/        markets.json: markets and assets, the single source of truth
infra/local/   docker-compose for PostgreSQL / Redis / Kafka / ClickHouse / Jaeger
scripts/       stack lifecycle, demo seeding, simulator, verification and E2E
docs/          demo documentation (setup, walkthrough, architecture, APIs, security)
learning/      exchange learning materials (chapters, labs, slides)
```

## Testing

```bash
pnpm build && pnpm typecheck
pnpm -r --if-present test
cargo test --manifest-path engines/matching-engine/Cargo.toml
pnpm test:e2e        # against a running, seeded stack (after pnpm demo:up)
```

## Learning path

1. Read [learning/01-what-is-cex.md](learning/01-what-is-cex.md) and [learning/02-system-architecture.md](learning/02-system-architecture.md).
2. Run the demo and follow [docs/demo-walkthrough.md](docs/demo-walkthrough.md) with learning mode on.
3. Go deeper per module: ledger ([chapter 05](learning/05-ledger.md)), matching ([06](learning/06-order-matching.md)), clearing ([07](learning/07-clearing-settlement-fees.md)), and so on. Each chapter ends with a section that maps the concept to this repo's code.
4. Try the interactive labs in [learning/interactive/](learning/interactive/index.html) and the slides in [learning/slides/](learning/slides/index.html). Both open directly in a browser with no server.

## Purpose

This project is for learning exchange system design. It is a simplified single-node demo on a simulated chain and is not built for production use or real funds.

## License

[MIT](LICENSE)
