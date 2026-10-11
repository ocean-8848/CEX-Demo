create table if not exists spot_orders (
  order_id uuid primary key,
  idempotency_key text not null unique,
  trace_id text not null,
  user_id text not null,
  account_id text not null,
  market text not null,
  side text not null,
  type text not null,
  time_in_force text not null,
  price numeric(36, 18) not null,
  quantity numeric(36, 18) not null,
  filled_quantity numeric(36, 18) not null,
  resting_quantity numeric(36, 18) not null default 0,
  status text not null,
  lock_asset_code text not null,
  lock_amount numeric(36, 18) not null,
  rejected_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists idx_spot_orders_user_id_created_at
  on spot_orders (user_id, created_at desc);

create index if not exists idx_spot_orders_account_id_status
  on spot_orders (account_id, status, created_at desc);

create table if not exists spot_trades (
  trade_id uuid primary key,
  market text not null,
  price numeric(36, 18) not null,
  quantity numeric(36, 18) not null,
  maker_order_id uuid not null,
  taker_order_id uuid not null,
  buyer_order_id uuid not null,
  seller_order_id uuid not null,
  buyer_user_id text not null,
  seller_user_id text not null,
  buyer_account_id text not null,
  seller_account_id text not null,
  settlement_id uuid not null,
  executed_at timestamptz not null
);

create index if not exists idx_spot_trades_buyer_user_id_executed_at
  on spot_trades (buyer_user_id, executed_at desc);

create index if not exists idx_spot_trades_seller_user_id_executed_at
  on spot_trades (seller_user_id, executed_at desc);
