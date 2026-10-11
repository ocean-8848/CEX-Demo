alter table spot_order_recovery_jobs
  add column if not exists last_claimed_at timestamptz,
  add column if not exists lease_heartbeat_at timestamptz,
  add column if not exists last_duration_ms integer,
  add column if not exists last_result text;

update spot_order_recovery_jobs
set
  last_claimed_at = coalesce(last_claimed_at, updated_at),
  lease_heartbeat_at = coalesce(lease_heartbeat_at, lease_expires_at, updated_at)
where status = 'processing';

create index if not exists idx_spot_order_recovery_jobs_dead_lettered_at
  on spot_order_recovery_jobs (dead_lettered_at desc nulls last);

create index if not exists idx_spot_order_recovery_jobs_lease_owner_status
  on spot_order_recovery_jobs (lease_owner, status)
  where lease_owner is not null;
