create table if not exists withdrawal_audit_logs (
  audit_log_id uuid primary key default gen_random_uuid(),
  withdrawal_id uuid not null references withdrawals(withdrawal_id) on delete cascade,
  operator_id text,
  operator_role text,
  action text not null check (action in ('requested', 'approved', 'rejected', 'broadcasted', 'confirmed')),
  trace_id text,
  before_snapshot jsonb not null default '{}'::jsonb,
  after_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_withdrawal_audit_logs_withdrawal_id
  on withdrawal_audit_logs (withdrawal_id, created_at desc);

create index if not exists idx_withdrawal_audit_logs_action
  on withdrawal_audit_logs (action, created_at desc);

create table if not exists wallet_notifications (
  notification_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  withdrawal_id uuid not null references withdrawals(withdrawal_id) on delete cascade,
  event_type text not null check (
    event_type in (
      'withdrawal.requested',
      'withdrawal.approved',
      'withdrawal.rejected',
      'withdrawal.broadcasted',
      'withdrawal.confirmed'
    )
  ),
  channel text not null check (channel in ('inbox')),
  status text not null check (status in ('pending', 'delivered', 'failed')),
  subject text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text
);

create index if not exists idx_wallet_notifications_user_id
  on wallet_notifications (user_id, created_at desc);

create index if not exists idx_wallet_notifications_withdrawal_id
  on wallet_notifications (withdrawal_id, created_at desc);

create index if not exists idx_wallet_notifications_status
  on wallet_notifications (status, created_at desc);
