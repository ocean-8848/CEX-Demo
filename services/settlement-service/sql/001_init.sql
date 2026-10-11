create table if not exists trade_settlements (
  settlement_id uuid primary key,
  trade_id uuid not null unique,
  market text not null,
  price numeric(36, 18) not null,
  quantity numeric(36, 18) not null,
  quote_amount numeric(36, 18) not null,
  fee_amount numeric(36, 18) not null,
  buyer_order_id uuid not null,
  seller_order_id uuid not null,
  buyer_user_id text not null,
  seller_user_id text not null,
  buyer_account_id text not null,
  seller_account_id text not null,
  buyer_settlement_journal_id uuid,
  seller_settlement_journal_id uuid,
  status text not null,
  created_at timestamptz not null,
  settled_at timestamptz not null
);

create index if not exists idx_trade_settlements_buyer_user_id
  on trade_settlements (buyer_user_id, settled_at desc);

create index if not exists idx_trade_settlements_seller_user_id
  on trade_settlements (seller_user_id, settled_at desc);
