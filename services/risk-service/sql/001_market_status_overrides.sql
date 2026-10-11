-- M4-3: runtime market status overrides. config/markets.json holds the default
-- status of every market; a row here (written by ops halt / resume) wins over it
-- until removed. `delisted` is config-only, so it is not a valid override.
create table if not exists risk_market_status_overrides (
  market text primary key,
  status text not null check (status in ('listed', 'halted')),
  reason text,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
