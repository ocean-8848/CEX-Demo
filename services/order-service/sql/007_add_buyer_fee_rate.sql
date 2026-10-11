-- Dual-sided fees: maker / taker rate charged to the buyer (in the base asset).
alter table spot_trades
  add column if not exists buyer_fee_rate numeric(36, 18) not null default 0;
