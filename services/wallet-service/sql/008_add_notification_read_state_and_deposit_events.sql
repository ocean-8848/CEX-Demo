-- M4-2 notification center:
-- 1. customer-facing read marker (read_at) lives next to the notification row,
--    so unread counts are one indexed query and survive reloads / devices;
-- 2. deposits produce notifications too ("deposit.credited"), so a row now
--    points at either a withdrawal or a deposit.

alter table wallet_notifications
  add column if not exists read_at timestamptz;

alter table wallet_notifications
  add column if not exists deposit_id uuid references deposits(deposit_id) on delete cascade;

alter table wallet_notifications
  alter column withdrawal_id drop not null;

-- db:prepare re-runs every migration on each start. Later migrations widen these
-- checks, so they are re-added here as NOT VALID: rows written under a later,
-- wider definition must not make this older definition fail on re-run. The latest
-- migration that redefines a check re-adds it fully validated.
alter table wallet_notifications
  drop constraint if exists wallet_notifications_event_type_check;

alter table wallet_notifications
  add constraint wallet_notifications_event_type_check check (
    event_type in (
      'withdrawal.requested',
      'withdrawal.approved',
      'withdrawal.rejected',
      'withdrawal.broadcasted',
      'withdrawal.confirmed',
      'deposit.credited'
    )
  ) not valid;

alter table wallet_notifications
  drop constraint if exists wallet_notifications_subject_check;

alter table wallet_notifications
  add constraint wallet_notifications_subject_check check (
    withdrawal_id is not null or deposit_id is not null
  ) not valid;

create index if not exists idx_wallet_notifications_user_unread
  on wallet_notifications (user_id, created_at desc)
  where read_at is null;

create unique index if not exists uq_wallet_notifications_deposit_event
  on wallet_notifications (deposit_id, event_type)
  where deposit_id is not null;
