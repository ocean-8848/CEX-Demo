create extension if not exists "pgcrypto";

create table if not exists identity_users (
  user_id uuid primary key,
  email text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_identity_users_status
  on identity_users (status);

create table if not exists user_two_factor_profiles (
  user_id uuid primary key references identity_users(user_id) on delete cascade,
  pending_secret text,
  secret text,
  issuer text not null default 'Web3 CEX',
  label text,
  enabled boolean not null default false,
  enabled_at timestamptz,
  last_verified_counter bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
