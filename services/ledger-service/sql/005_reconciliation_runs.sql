-- Scheduled / manual reconciliation runs (balance + order-vs-lock) and the
-- circuit breaker decisions they produced. `report` keeps the full run record
-- (capped difference lists); the scalar columns are for listing and filtering.
create table if not exists ledger_reconciliation_runs (
  run_id uuid primary key,
  trigger text not null,
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  duration_ms integer not null default 0,
  balance_mismatch_count integer not null default 0,
  order_lock_mismatch_count integer not null default 0,
  mismatched_assets text[] not null default '{}',
  tripped_assets text[] not null default '{}',
  report jsonb not null default '{}'::jsonb
);

create index if not exists idx_ledger_reconciliation_runs_started_at
  on ledger_reconciliation_runs (started_at desc);
