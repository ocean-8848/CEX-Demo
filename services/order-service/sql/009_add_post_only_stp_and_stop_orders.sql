-- Matching enhancements: post-only (maker-only) limit orders, self-trade
-- prevention mode and stop orders (stop_limit / stop_market) that wait in
-- status 'pending_trigger' until the last trade price crosses trigger_price.
alter table spot_orders add column if not exists post_only boolean not null default false;
alter table spot_orders add column if not exists stp_mode text;
alter table spot_orders add column if not exists trigger_price numeric(36, 18);
alter table spot_orders add column if not exists triggered_at timestamptz;

create index if not exists idx_spot_orders_pending_trigger
  on spot_orders (market, created_at)
  where status = 'pending_trigger';

