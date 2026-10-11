-- Dual-sided fees: the buyer pays its fee in the base asset it receives.
alter table trade_settlements
  add column if not exists buyer_fee_amount numeric(36, 18) not null default 0;

alter table trade_settlement_summary_rollups
  add column if not exists base_fee_amount numeric(36, 18) not null default 0;
