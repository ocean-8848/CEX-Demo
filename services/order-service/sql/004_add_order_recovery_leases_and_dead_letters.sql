alter table spot_order_recovery_jobs
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists dead_lettered_at timestamptz;

create index if not exists idx_spot_order_recovery_jobs_lease_expires_at
  on spot_order_recovery_jobs (lease_expires_at asc);

create index if not exists idx_spot_order_recovery_jobs_dead_lettered_at
  on spot_order_recovery_jobs (dead_lettered_at desc);
