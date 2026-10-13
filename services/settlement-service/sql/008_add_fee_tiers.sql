-- VIP fee tiers: the rate and tier each side was charged are copied from the
-- trade, so a settlement row alone explains its fee amounts (replay / audit).
alter table trade_settlements
  add column if not exists seller_fee_rate numeric(36, 18);

alter table trade_settlements
  add column if not exists buyer_fee_rate numeric(36, 18);

alter table trade_settlements
  add column if not exists seller_fee_tier text;

alter table trade_settlements
  add column if not exists buyer_fee_tier text;
