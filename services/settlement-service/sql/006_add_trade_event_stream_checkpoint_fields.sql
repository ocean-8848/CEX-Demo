alter table if exists trade_event_consumer_checkpoints
  add column if not exists last_stream_entry_id text,
  add column if not exists last_stream_published_at timestamptz;

create index if not exists idx_trade_event_consumer_checkpoints_stream_entry
  on trade_event_consumer_checkpoints (last_stream_entry_id);
