alter table trade_settlements
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_attempt_at timestamptz;

update trade_settlements
set
  attempt_count = case when status = 'settled' then greatest(attempt_count, 1) else attempt_count end,
  updated_at = coalesce(updated_at, settled_at, created_at),
  last_attempt_at = coalesce(last_attempt_at, settled_at, created_at)
where true;

alter table trade_settlements
  alter column settled_at drop not null;

create table if not exists trade_settlement_recovery_jobs (
  job_id uuid primary key,
  trade_id uuid not null unique references trade_settlements(trade_id),
  market text not null,
  stage text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz
);

create index if not exists idx_trade_settlement_recovery_jobs_status_next_attempt_at
  on trade_settlement_recovery_jobs (status, next_attempt_at asc);

create index if not exists idx_trade_settlement_recovery_jobs_market_created_at
  on trade_settlement_recovery_jobs (market, created_at desc);
