alter table wallet_addresses
  add column if not exists ledger_account_id uuid;

alter table deposits
  add column if not exists ledger_account_id uuid;

alter table deposits
  add column if not exists ledger_journal_id uuid;
