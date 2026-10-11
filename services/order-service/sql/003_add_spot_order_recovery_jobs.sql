create table if not exists spot_order_recovery_jobs (
  job_id uuid primary key,
  order_id uuid not null references spot_orders(order_id),
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

create index if not exists idx_spot_order_recovery_jobs_status_next_attempt_at
  on spot_order_recovery_jobs (status, next_attempt_at asc);

create index if not exists idx_spot_order_recovery_jobs_order_id
  on spot_order_recovery_jobs (order_id, created_at desc);
