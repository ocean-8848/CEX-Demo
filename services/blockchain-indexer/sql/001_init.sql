create extension if not exists "pgcrypto";

create table if not exists blockchain_deposit_observations (
  observation_id uuid primary key default gen_random_uuid(),
  network text not null,
  asset_code text not null,
  address text not null,
  tx_hash text not null,
  amount numeric(36, 18) not null check (amount > 0),
  confirmations integer not null default 0,
  block_number bigint,
  status text not null,
  wallet_deposit_id text,
  reorg_detected_at timestamptz,
  reorged_from_block_number bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, tx_hash, address)
);

create index if not exists idx_blockchain_deposit_observations_status
  on blockchain_deposit_observations (status);

create index if not exists idx_blockchain_deposit_observations_block_number
  on blockchain_deposit_observations (network, block_number);

create table if not exists blockchain_withdrawal_observations (
  observation_id uuid primary key default gen_random_uuid(),
  network text not null,
  asset_code text not null,
  tx_hash text not null,
  confirmations integer not null default 0,
  block_number bigint,
  status text not null,
  wallet_withdrawal_id text,
  reorg_detected_at timestamptz,
  reorged_from_block_number bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, tx_hash)
);

create index if not exists idx_blockchain_withdrawal_observations_status
  on blockchain_withdrawal_observations (status);

create index if not exists idx_blockchain_withdrawal_observations_block_number
  on blockchain_withdrawal_observations (network, block_number);

create table if not exists blockchain_scan_cursors (
  cursor_id uuid primary key default gen_random_uuid(),
  observation_type text not null check (observation_type in ('deposit', 'withdrawal')),
  network text not null,
  last_scanned_block bigint,
  last_finalized_block bigint,
  reorg_detected_at timestamptz,
  reorg_detected_block bigint,
  updated_at timestamptz not null default now(),
  unique (observation_type, network)
);
