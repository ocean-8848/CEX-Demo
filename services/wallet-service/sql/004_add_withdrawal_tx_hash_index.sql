create index if not exists idx_withdrawals_network_tx_hash
  on withdrawals (network, tx_hash)
  where tx_hash is not null;
