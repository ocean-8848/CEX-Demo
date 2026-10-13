-- Login security: every login attempt is recorded (success / failure / locked),
-- devices are remembered per user (new-device detection), and each session
-- remembers the device it was created on so a device's sessions can be revoked.

create table if not exists identity_login_events (
  event_id uuid primary key,
  user_id uuid references identity_users(user_id) on delete cascade,
  email text not null,
  scope text not null,
  device_id text not null,
  device_label text not null default '',
  ip_address text,
  user_agent text,
  outcome text not null check (outcome in ('success', 'failure', 'locked')),
  failure_code text,
  is_new_device boolean not null default false,
  session_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_identity_login_events_user_created
  on identity_login_events (user_id, created_at desc);

create index if not exists idx_identity_login_events_new_device
  on identity_login_events (user_id, created_at desc)
  where is_new_device = true and outcome = 'success';

create table if not exists identity_user_devices (
  user_id uuid not null references identity_users(user_id) on delete cascade,
  device_id text not null,
  device_label text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_ip_address text,
  last_user_agent text,
  login_count integer not null default 0,
  flagged_new boolean not null default false,
  revoked_at timestamptz,
  primary key (user_id, device_id)
);

alter table identity_ops_sessions
  add column if not exists device_id text;

create index if not exists idx_identity_ops_sessions_user_device
  on identity_ops_sessions (user_id, device_id)
  where revoked_at is null;
