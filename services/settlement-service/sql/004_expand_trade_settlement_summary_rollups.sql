create index if not exists idx_trade_settlement_summary_rollups_scope_lookup
  on trade_settlement_summary_rollups (scope_type, scope_key, status, updated_at desc);

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
    'user'::text as scope_type,
    buyer_user_id::text as scope_key,
    null::text as market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements

  union all

  select
    'user'::text as scope_type,
    seller_user_id::text as scope_key,
    null::text as market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements
  where seller_user_id <> buyer_user_id

  union all

  select
    'user_market'::text as scope_type,
    buyer_user_id::text || ':' || market as scope_key,
    market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements

  union all

  select
    'user_market'::text as scope_type,
    seller_user_id::text || ':' || market as scope_key,
    market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements
  where seller_user_id <> buyer_user_id

  union all

  select
    'order'::text as scope_type,
    buyer_order_id::text as scope_key,
    null::text as market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements

  union all

  select
    'order'::text as scope_type,
    seller_order_id::text as scope_key,
    null::text as market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements
  where seller_order_id <> buyer_order_id

  union all

  select
    'order_market'::text as scope_type,
    buyer_order_id::text || ':' || market as scope_key,
    market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements

  union all

  select
    'order_market'::text as scope_type,
    seller_order_id::text || ':' || market as scope_key,
    market,
    status,
    quantity,
    quote_amount,
    fee_amount,
    updated_at
  from trade_settlements
  where seller_order_id <> buyer_order_id
) as rollups
group by scope_type, scope_key, market, status
on conflict (scope_type, scope_key, status) do update set
  settlement_count = excluded.settlement_count,
  quantity = excluded.quantity,
  quote_amount = excluded.quote_amount,
  fee_amount = excluded.fee_amount,
  updated_at = excluded.updated_at;
