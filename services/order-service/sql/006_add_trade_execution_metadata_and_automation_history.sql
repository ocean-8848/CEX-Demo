alter table if exists spot_trades
  add column if not exists seller_fee_rate numeric(36, 18),
  add column if not exists execution_id text,
  add column if not exists execution_batch_id text,
  add column if not exists execution_sequence bigint,
  add column if not exists execution_batch_sequence integer,
  add column if not exists replay_cursor text,
  add column if not exists protocol_version text;

update spot_trades
set
  seller_fee_rate = coalesce(seller_fee_rate, 0),
  execution_id = coalesce(execution_id, trade_id::text),
  execution_batch_id = coalesce(execution_batch_id, market || ':' || taker_order_id::text),
  execution_sequence = coalesce(execution_sequence, 0),
  execution_batch_sequence = coalesce(execution_batch_sequence, 1),
  replay_cursor = coalesce(replay_cursor, market || ':0'),
  protocol_version = coalesce(protocol_version, 'v1')
where
  seller_fee_rate is null
  or
  execution_id is null
  or execution_batch_id is null
  or execution_sequence is null
  or execution_batch_sequence is null
  or replay_cursor is null
  or protocol_version is null;

alter table if exists spot_trades
  alter column seller_fee_rate set not null,
  alter column execution_id set not null,
  alter column execution_batch_id set not null,
  alter column execution_sequence set not null,
  alter column execution_batch_sequence set not null,
  alter column replay_cursor set not null,
  alter column protocol_version set not null;

create unique index if not exists idx_spot_trades_execution_id
  on spot_trades (execution_id);

create index if not exists idx_spot_trades_market_execution_sequence
  on spot_trades (market, execution_sequence desc);

create index if not exists idx_spot_trades_execution_batch_id
  on spot_trades (execution_batch_id, execution_batch_sequence asc);

create table if not exists spot_order_automation_executions (
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

create index if not exists idx_spot_order_automation_executions_started_at
  on spot_order_automation_executions (started_at desc);

create index if not exists idx_spot_order_automation_executions_type_status
  on spot_order_automation_executions (execution_type, status, started_at desc);
