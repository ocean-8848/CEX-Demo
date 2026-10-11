create table if not exists trade_settlement_summary_rollups (
  scope_type text not null,
  scope_key text not null,
  market text,
  status text not null,
  settlement_count bigint not null default 0,
  quantity numeric(36, 18) not null default 0,
  quote_amount numeric(36, 18) not null default 0,
  fee_amount numeric(36, 18) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_key, status)
);

insert into trade_settlement_summary_rollups (
  scope_type,
  scope_key,
  market,
  status,
  settlement_count,
  quantity,
  quote_amount,
  fee_amount,
  updated_at
)
select
  scope_type,
  scope_key,
  market,
  status,
  count(*) as settlement_count,
  coalesce(sum(quantity), 0) as quantity,
  coalesce(sum(quote_amount), 0) as quote_amount,
  coalesce(sum(fee_amount), 0) as fee_amount,
  max(updated_at) as updated_at
from (
  select
    'global'::text as scope_type,
    'all'::text as scope_key,
    null::text as market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements

  union all

  select
    'market'::text as scope_type,
    market as scope_key,
    market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements
) as rollups
group by scope_type, scope_key, market, status
on conflict (scope_type, scope_key, status) do update set
  settlement_count = excluded.settlement_count,
  quantity = excluded.quantity,
  quote_amount = excluded.quote_amount,
  fee_amount = excluded.fee_amount,
  updated_at = excluded.updated_at;

create index if not exists idx_trade_settlement_summary_rollups_market_status
  on trade_settlement_summary_rollups (market, status, updated_at desc);

create index if not exists idx_trade_settlement_summary_rollups_scope_lookup
  on trade_settlement_summary_rollups (scope_type, scope_key, status, updated_at desc);
