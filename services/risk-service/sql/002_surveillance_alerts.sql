-- A9 market surveillance alerts. One row per finding (alert_key is
-- deterministic per detector + subject + window), evidence as JSON.
create table if not exists risk_surveillance_alerts (
  alert_id uuid primary key,
  alert_key text not null unique,
  type text not null check (type in ('wash_trade', 'concentrated_volume', 'spoofing', 'price_move')),
  market text not null,
  user_id text,
  severity text not null check (severity in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'dismissed')),
  summary text not null,
  metrics jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  market_maker boolean not null default false,
  window_start timestamptz not null,
  window_end timestamptz not null,
  first_detected_at timestamptz not null,
  last_detected_at timestamptz not null,
  status_note text,
  status_updated_by text,
  status_updated_at timestamptz
);

create index if not exists idx_risk_surveillance_alerts_status
  on risk_surveillance_alerts (status, last_detected_at desc);

create index if not exists idx_risk_surveillance_alerts_subject
  on risk_surveillance_alerts (type, market, user_id, last_detected_at desc);

-- Append-only audit of detection and every review decision.
create table if not exists risk_surveillance_alert_events (
  event_id uuid primary key,
  alert_id uuid not null,
  action text not null check (action in ('detected', 'acknowledged', 'dismissed', 'reopened')),
  from_status text,
  to_status text not null,
  note text,
  actor text not null,
  created_at timestamptz not null
);

create index if not exists idx_risk_surveillance_alert_events_alert
  on risk_surveillance_alert_events (alert_id, created_at);
