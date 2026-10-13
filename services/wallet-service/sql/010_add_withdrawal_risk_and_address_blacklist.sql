-- Simplified KYT for withdrawals:
-- 1. every withdrawal stores the risk score / level / reasons computed at request time;
-- 2. ops-managed address blacklist (rows are never deleted: removal keeps who / why);
-- 3. account security notifications (new device login) share the wallet inbox.

alter table withdrawals
  add column if not exists risk_score integer;

alter table withdrawals
  add column if not exists risk_level text;

alter table withdrawals
  add column if not exists risk_reasons jsonb not null default '[]'::jsonb;

create index if not exists idx_withdrawals_risk_level
  on withdrawals (risk_level, requested_at desc)
  where risk_level is not null;

create index if not exists idx_withdrawals_user_to_address
  on withdrawals (user_id, network, to_address);

create table if not exists withdrawal_address_blacklist (
  entry_id uuid primary key default gen_random_uuid(),
  network text not null,
  address text not null,
  category text not null check (category in ('sanctioned', 'mixer', 'scam', 'hack', 'other')),
  reason text not null,
  source text not null default 'ops' check (source in ('seed', 'ops')),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by text,
  created_at timestamptz not null default now(),
  removed_by text,
  removed_at timestamptz,
  removal_reason text
);

create unique index if not exists uq_withdrawal_address_blacklist_active
  on withdrawal_address_blacklist (network, address)
  where status = 'active';

create index if not exists idx_withdrawal_address_blacklist_created_at
  on withdrawal_address_blacklist (created_at desc);

-- Demo seed: fabricated addresses standing in for sanctioned / stolen-fund wallets.
insert into withdrawal_address_blacklist (network, address, category, reason, source, created_by)
values
  ('ethereum', '0xbad0000000000000000000000000000000000001', 'sanctioned', '演示：制裁名单地址', 'seed', 'system:seed'),
  ('ethereum', '0xbad0000000000000000000000000000000000002', 'hack', '演示：交易所被盗资金归集地址', 'seed', 'system:seed'),
  ('ethereum', '0xbad0000000000000000000000000000000000003', 'mixer', '演示：混币合约', 'seed', 'system:seed')
on conflict (network, address) where status = 'active' do nothing;

alter table wallet_notifications
  drop constraint if exists wallet_notifications_event_type_check;

alter table wallet_notifications
  add constraint wallet_notifications_event_type_check check (
    event_type in (
      'withdrawal.requested',
      'withdrawal.approved',
      'withdrawal.rejected',
      'withdrawal.broadcasted',
      'withdrawal.confirmed',
      'deposit.credited',
      'security.new_device_login'
    )
  );

alter table wallet_notifications
  drop constraint if exists wallet_notifications_subject_check;

alter table wallet_notifications
  add constraint wallet_notifications_subject_check check (
    withdrawal_id is not null or deposit_id is not null or event_type like 'security.%'
  );
