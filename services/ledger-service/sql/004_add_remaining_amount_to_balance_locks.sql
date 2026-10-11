alter table balance_locks
  add column if not exists remaining_amount numeric(36, 18);

update balance_locks
set remaining_amount = amount
where remaining_amount is null;

alter table balance_locks
  alter column remaining_amount set not null;
