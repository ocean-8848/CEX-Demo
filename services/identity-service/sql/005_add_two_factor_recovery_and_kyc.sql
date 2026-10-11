-- M4-1: self-service 2FA. Recovery codes are one-time and stored only as hashes;
-- `changed_at` records the last enable / disable so wallet-service can apply a
-- withdrawal cooldown after a security change (M5-2).
alter table user_two_factor_profiles
  add column if not exists changed_at timestamptz;

create table if not exists identity_two_factor_recovery_codes (
  recovery_code_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references identity_users(user_id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (user_id, code_hash)
);

create index if not exists idx_identity_two_factor_recovery_codes_user
  on identity_two_factor_recovery_codes (user_id, used_at);

-- M4-4: KYC tiers (unverified / L1 / L2). Demo only: the "ID number" is masked
-- before it is stored and nothing is verified against a real provider.
alter table identity_users
  add column if not exists kyc_tier text not null default 'unverified';

alter table identity_users
  add column if not exists kyc_tier_updated_at timestamptz;

create table if not exists identity_kyc_requests (
  request_id uuid primary key,
  user_id uuid not null references identity_users(user_id) on delete cascade,
  requested_tier text not null check (requested_tier in ('L1', 'L2')),
  full_name text not null,
  id_number_masked text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approved_tier text check (approved_tier in ('L1', 'L2')),
  reviewed_by text,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists idx_identity_kyc_requests_status
  on identity_kyc_requests (status, created_at desc);

create index if not exists idx_identity_kyc_requests_user
  on identity_kyc_requests (user_id, created_at desc);

-- Every tier change (review approval or manual ops adjustment) is appended here.
create table if not exists identity_kyc_events (
  event_id uuid primary key,
  user_id uuid not null references identity_users(user_id) on delete cascade,
  from_tier text not null,
  to_tier text not null,
  action text not null check (action in ('request_approved', 'request_rejected', 'tier_adjusted')),
  request_id uuid,
  actor_id text,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_identity_kyc_events_user
  on identity_kyc_events (user_id, created_at desc);
