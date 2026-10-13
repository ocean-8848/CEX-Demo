-- Emergency switches (运营紧急开关). A row exists only while a switch is ON;
-- turning it off deletes the row. Every change is appended to
-- risk_control_switch_events, which is the switch audit trail (ops-console also
-- writes its own ops_action_audit_logs row for manual changes).
create table if not exists risk_control_switches (
  switch_key text primary key,
  scope text not null check (scope in ('withdrawals_global', 'withdrawals_asset', 'api_write')),
  asset_code text,
  reason text,
  source text not null default 'manual' check (source in ('manual', 'automatic')),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table if not exists risk_control_switch_events (
  event_id bigserial primary key,
  switch_key text not null,
  scope text not null,
  asset_code text,
  action text not null check (action in ('enabled', 'disabled')),
  reason text,
  source text not null default 'manual',
  operator text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_risk_control_switch_events_created_at
  on risk_control_switch_events (created_at desc);
