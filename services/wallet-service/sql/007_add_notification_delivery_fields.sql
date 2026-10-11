alter table wallet_notifications
  add column if not exists delivery_attempts integer not null default 0;

alter table wallet_notifications
  add column if not exists delivery_receipt jsonb not null default '{}'::jsonb;

alter table wallet_notifications
  add column if not exists last_attempted_at timestamptz;

alter table wallet_notifications
  add column if not exists next_attempt_at timestamptz;

create index if not exists idx_wallet_notifications_delivery_queue
  on wallet_notifications (status, next_attempt_at, created_at);
