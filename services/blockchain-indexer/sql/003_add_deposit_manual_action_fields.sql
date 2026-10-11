alter table blockchain_deposit_observations
  add column if not exists last_manual_action text;

alter table blockchain_deposit_observations
  add column if not exists last_manual_action_at timestamptz;

alter table blockchain_deposit_observations
  add column if not exists last_manual_action_by text;

alter table blockchain_deposit_observations
  add column if not exists last_manual_action_note text;

create index if not exists idx_blockchain_deposit_observations_status_created_at
  on blockchain_deposit_observations (status, created_at);
