alter table identity_users
  add column if not exists display_name text;

alter table identity_users
  add column if not exists user_type text not null default 'customer';

create unique index if not exists idx_identity_users_email_ci
  on identity_users (lower(email))
  where email is not null;

create table if not exists identity_user_credentials (
  user_id uuid primary key references identity_users(user_id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists identity_user_roles (
  user_id uuid not null references identity_users(user_id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create index if not exists idx_identity_user_roles_role
  on identity_user_roles (role);

create table if not exists identity_ops_sessions (
  session_id uuid primary key,
  user_id uuid not null references identity_users(user_id) on delete cascade,
  token_hash text not null unique,
  scope text not null default 'ops_console',
  roles jsonb not null default '[]'::jsonb,
  permissions jsonb not null default '[]'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_identity_ops_sessions_user_id
  on identity_ops_sessions (user_id);

create index if not exists idx_identity_ops_sessions_active
  on identity_ops_sessions (expires_at, revoked_at);
