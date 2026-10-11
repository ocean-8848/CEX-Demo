alter table blockchain_deposit_observations
  add column if not exists block_hash text;

alter table blockchain_withdrawal_observations
  add column if not exists block_hash text;

create index if not exists idx_blockchain_deposit_observations_block_hash
  on blockchain_deposit_observations (network, block_hash);

create index if not exists idx_blockchain_withdrawal_observations_block_hash
  on blockchain_withdrawal_observations (network, block_hash);
