alter table outbox_events
  add column if not exists publish_attempts integer not null default 0;

alter table outbox_events
  add column if not exists last_error text;

alter table outbox_events
  add column if not exists last_attempted_at timestamptz;

alter table outbox_events
  add column if not exists next_attempt_at timestamptz;

alter table outbox_events
  add column if not exists dead_lettered_at timestamptz;

create index if not exists idx_outbox_events_publishable
  on outbox_events (created_at, next_attempt_at)
  where published_at is null and dead_lettered_at is null;
