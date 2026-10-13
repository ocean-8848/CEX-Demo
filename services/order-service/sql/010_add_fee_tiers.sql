-- VIP fee tiers: the tier each side's rate was resolved from is recorded on the
-- trade next to the rate, so replay / audit always sees the fee actually charged.
alter table spot_trades
  add column if not exists buyer_fee_tier text;

alter table spot_trades
  add column if not exists seller_fee_tier text;

-- Trailing-volume lookups filter by user + executed_at (indexes from 001) and
-- surveillance scans by executed_at across all users.
create index if not exists idx_spot_trades_executed_at
  on spot_trades (executed_at desc);

create index if not exists idx_spot_orders_cancelled_at
  on spot_orders (cancelled_at desc)
  where cancelled_at is not null;

-- Ops-assigned tier overrides (e.g. market-maker programme). One row per user.
create table if not exists spot_fee_tier_overrides (
  user_id text primary key,
  tier text not null,
  note text not null,
  assigned_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- Append-only audit of every override change (set / clear).
create table if not exists spot_fee_tier_override_audit (
  audit_id uuid primary key,
  user_id text not null,
  action text not null,
  previous_tier text,
  tier text,
  note text not null,
  actor text not null,
  created_at timestamptz not null
);

create index if not exists idx_spot_fee_tier_override_audit_user
  on spot_fee_tier_override_audit (user_id, created_at desc);
