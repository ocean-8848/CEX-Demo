create extension if not exists "pgcrypto";

create table if not exists accounts (
  account_id uuid primary key default gen_random_uuid(),
  user_id uuid,
  account_type text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists balances (
  balance_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(account_id),
  asset_code text not null,
  available numeric(36, 18) not null default 0,
  locked numeric(36, 18) not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, asset_code)
);

create table if not exists ledger_journals (
  journal_id uuid primary key default gen_random_uuid(),
  business_type text not null,
  business_id text not null,
  idempotency_key text not null,
  trace_id text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);

create table if not exists ledger_entries (
  entry_id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references ledger_journals(journal_id),
  account_id uuid not null references accounts(account_id),
  asset_code text not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount numeric(36, 18) not null check (amount > 0),
  reference_type text not null,
  reference_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_entries_journal_id
  on ledger_entries (journal_id);

create index if not exists idx_ledger_entries_account_asset
  on ledger_entries (account_id, asset_code);

create table if not exists balance_locks (
  lock_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(account_id),
  asset_code text not null,
  reference_type text not null,
  reference_id text not null,
  amount numeric(36, 18) not null check (amount > 0),
  status text not null default 'locked',
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (reference_type, reference_id, account_id, asset_code)
);

create table if not exists outbox_events (
  event_id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
