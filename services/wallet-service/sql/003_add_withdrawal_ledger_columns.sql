alter table withdrawals
  add column if not exists ledger_account_id uuid;

alter table withdrawals
  add column if not exists frozen_amount numeric(36, 18) not null default 0;

alter table withdrawals
  add column if not exists freeze_reference_id text;

create index if not exists idx_withdrawals_ledger_account_id
  on withdrawals (ledger_account_id);
