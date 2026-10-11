alter table identity_users
  add column if not exists status_reason text;

alter table identity_users
  add column if not exists status_updated_at timestamptz;

update identity_users
set status_updated_at = coalesce(status_updated_at, updated_at)
where status_updated_at is null;

alter table identity_ops_sessions
  alter column scope set default 'ops_console';

create index if not exists idx_identity_ops_sessions_scope_active
  on identity_ops_sessions (scope, expires_at, revoked_at);

create table if not exists identity_api_keys (
  api_key_id uuid primary key,
  user_id uuid not null references identity_users(user_id) on delete cascade,
  label text not null,
  key_prefix text not null,
  token_hash text not null unique,
  status text not null default 'active',
  created_by text,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_identity_api_keys_user_id
  on identity_api_keys (user_id, created_at desc);

create index if not exists idx_identity_api_keys_status
  on identity_api_keys (status, revoked_at);
