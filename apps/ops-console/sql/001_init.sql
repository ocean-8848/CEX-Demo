create table if not exists ops_action_audit_logs (
  audit_log_id uuid primary key,
  batch_id uuid,
  operator_user_id text not null,
  operator_email text,
  operator_roles jsonb not null default '[]'::jsonb,
  permission text not null,
  action text not null,
  target_type text not null,
  target_id text,
  request_payload jsonb,
  response_payload jsonb,
  status text not null,
  error_code text,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz not null
);

create index if not exists idx_ops_action_audit_logs_operator_started_at
  on ops_action_audit_logs (operator_user_id, started_at desc);

create index if not exists idx_ops_action_audit_logs_action_started_at
  on ops_action_audit_logs (action, started_at desc);

create index if not exists idx_ops_action_audit_logs_target_started_at
  on ops_action_audit_logs (target_type, target_id, started_at desc);

create index if not exists idx_ops_action_audit_logs_status_started_at
  on ops_action_audit_logs (status, started_at desc);

create index if not exists idx_ops_action_audit_logs_batch_id
  on ops_action_audit_logs (batch_id);
