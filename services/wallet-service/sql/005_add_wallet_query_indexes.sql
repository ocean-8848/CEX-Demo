create index if not exists idx_deposits_user_detected_at
  on deposits (user_id, detected_at desc);

create index if not exists idx_deposits_network_status_detected_at
  on deposits (network, status, detected_at desc);

create index if not exists idx_withdrawals_user_requested_at
  on withdrawals (user_id, requested_at desc);

create index if not exists idx_withdrawals_review_queue
  on withdrawals (review_status, status, requested_at desc);

create index if not exists idx_withdrawal_address_book_whitelist_lookup
  on withdrawal_address_book (user_id, network, address)
  where is_whitelisted = true;
