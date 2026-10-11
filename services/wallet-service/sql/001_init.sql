create extension if not exists "pgcrypto";

create table if not exists wallet_addresses (
  wallet_address_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_code text not null,
  network text not null,
  address text not null,
  tag text,
  provider_account_id text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (network, address)
);

create table if not exists deposits (
  deposit_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_code text not null,
  network text not null,
  address text not null,
  tx_hash text not null,
  amount numeric(36, 18) not null check (amount > 0),
  block_number bigint,
  confirmations integer not null default 0,
  status text not null,
  detected_at timestamptz not null default now(),
  confirmed_at timestamptz,
  credited_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (network, tx_hash, address)
);

create index if not exists idx_deposits_user_id
  on deposits (user_id);

create index if not exists idx_deposits_status
  on deposits (status);

create table if not exists withdrawals (
  withdrawal_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_code text not null,
  network text not null,
  to_address text not null,
  amount numeric(36, 18) not null check (amount > 0),
  fee numeric(36, 18) not null default 0,
  status text not null,
  review_status text not null default 'pending',
  custody_request_id text,
  tx_hash text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  broadcasted_at timestamptz,
  confirmed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_withdrawals_user_id
  on withdrawals (user_id);

create index if not exists idx_withdrawals_status
  on withdrawals (status);

create table if not exists withdrawal_address_book (
  address_book_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  network text not null,
  address text not null,
  label text not null,
  is_whitelisted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, network, address)
);
