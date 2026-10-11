create extension if not exists "pgcrypto";

create table if not exists custody_transfers (
  custody_transfer_id uuid primary key default gen_random_uuid(),
  reference_id text not null,
  asset_code text not null,
  network text not null,
  to_address text not null,
  amount numeric(36, 18) not null check (amount > 0),
  fee numeric(36, 18) not null check (fee >= 0),
  idempotency_key text not null unique,
  provider_name text not null,
  provider_transfer_id text,
  status text not null check (status in ('accepted', 'broadcasted', 'confirmed', 'failed')),
  tx_hash text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  last_error_code text,
  last_error_message text,
  broadcasted_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_custody_transfers_reference_id
  on custody_transfers (reference_id);

create index if not exists idx_custody_transfers_status
  on custody_transfers (status);

create index if not exists idx_custody_transfers_tx_hash
  on custody_transfers (network, tx_hash);

create table if not exists custody_transfer_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  custody_transfer_id uuid not null references custody_transfers(custody_transfer_id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  action text not null check (action in ('broadcast', 'retry', 'sync_status')),
  status text not null check (status in ('succeeded', 'failed')),
  provider_name text not null,
  tx_hash text,
  error_code text,
  error_message text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_custody_transfer_attempts_transfer_id
  on custody_transfer_attempts (custody_transfer_id, created_at desc);
