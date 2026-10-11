alter table if exists trade_settlements
  add column if not exists execution_id text,
  add column if not exists execution_batch_id text,
  add column if not exists execution_sequence bigint,
  add column if not exists execution_batch_sequence integer,
  add column if not exists replay_cursor text,
  add column if not exists protocol_version text;

alter table if exists trade_settlement_recovery_jobs
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_claimed_at timestamptz,
  add column if not exists lease_heartbeat_at timestamptz,
  add column if not exists last_duration_ms integer,
  add column if not exists last_result text;

create index if not exists idx_trade_settlements_market_execution_sequence
  on trade_settlements (market, execution_sequence desc);

create index if not exists idx_trade_settlement_recovery_jobs_lease_expires_at
  on trade_settlement_recovery_jobs (lease_expires_at);

create table if not exists settlement_automation_executions (
  execution_id text primary key,
  execution_type text not null,
  status text not null,
  trigger text not null,
  market text,
  worker_id text,
  target_id text,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  duration_ms integer not null
);

create index if not exists idx_settlement_automation_executions_started_at
  on settlement_automation_executions (started_at desc);

create index if not exists idx_settlement_automation_executions_type_status
  on settlement_automation_executions (execution_type, status, started_at desc);

create table if not exists trade_event_consumer_checkpoints (
  consumer_id text not null,
  event_type text not null,
  market text not null,
  schema_id text not null,
  schema_version integer not null,
  protocol_version text not null,
  last_event_id text not null,
  last_trade_id text not null,
  last_execution_sequence bigint not null,
  last_replay_cursor text not null,
  updated_at timestamptz not null,
  primary key (consumer_id, market)
);

create index if not exists idx_trade_event_consumer_checkpoints_updated_at
  on trade_event_consumer_checkpoints (updated_at desc);
