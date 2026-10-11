alter table balance_locks
  add column if not exists consumed_at timestamptz;
