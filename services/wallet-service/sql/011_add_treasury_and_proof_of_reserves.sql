-- Custody layering (deposit addresses -> hot wallet <-> cold wallet) and
-- proof of reserves. Platform on-chain holdings are derived from these rows
-- plus credited deposits and broadcast withdrawals; the ledger is not touched.

create table if not exists treasury_transfers (
  transfer_id uuid primary key,
  kind text not null check (kind in ('genesis', 'sweep', 'rebalance_to_cold', 'rebalance_to_hot')),
  status text not null check (status in ('proposed', 'approved', 'broadcasted', 'confirmed', 'rejected', 'failed')),
  trigger text not null,
  asset_code text not null,
  network text not null,
  amount numeric(36, 18) not null check (amount > 0),
  from_wallet text not null check (from_wallet in ('external', 'deposit', 'hot', 'cold')),
  to_wallet text not null check (to_wallet in ('hot', 'cold')),
  from_address text,
  to_address text not null,
  idempotency_key text not null unique,
  reason text,
  requested_by text not null,
  reviewed_by text,
  review_note text,
  custody_transfer_id text,
  provider_name text,
  tx_hash text,
  confirmations integer not null default 0,
  block_number bigint,
  last_error text,
  events jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  broadcasted_at timestamptz,
  confirmed_at timestamptz,
  rejected_at timestamptz,
  failed_at timestamptz
);

create index if not exists idx_treasury_transfers_status
  on treasury_transfers (status, created_at desc);

create index if not exists idx_treasury_transfers_asset
  on treasury_transfers (asset_code, kind, status);

create index if not exists idx_treasury_transfers_tx_hash
  on treasury_transfers (network, tx_hash);

-- Which credited deposits a sweep moved. A deposit can only be in one live
-- sweep (primary key); a failed sweep deletes its rows so they are swept again.
create table if not exists treasury_sweep_deposits (
  deposit_id uuid primary key,
  transfer_id uuid not null references treasury_transfers (transfer_id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_treasury_sweep_deposits_transfer
  on treasury_sweep_deposits (transfer_id);

create table if not exists proof_of_reserves_snapshots (
  snapshot_id uuid primary key,
  merkle_root text not null,
  leaf_count integer not null,
  tree_depth integer not null,
  assets jsonb not null default '[]'::jsonb,
  generated_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_proof_of_reserves_snapshots_created
  on proof_of_reserves_snapshots (created_at desc);

-- One leaf per user per snapshot. The nonce salts the user id so the
-- published leaf hashes reveal nothing about who holds what.
create table if not exists proof_of_reserves_leaves (
  snapshot_id uuid not null references proof_of_reserves_snapshots (snapshot_id) on delete cascade,
  user_id uuid not null,
  leaf_index integer not null,
  nonce text not null,
  user_hash text not null,
  balances jsonb not null,
  leaf_hash text not null,
  proof jsonb not null,
  primary key (snapshot_id, user_id)
);
