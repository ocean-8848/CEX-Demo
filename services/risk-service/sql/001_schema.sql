-- risk-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

-- Name: risk_control_switch_events; Type: TABLE
CREATE TABLE risk_control_switch_events (
    event_id bigint NOT NULL,
    switch_key text NOT NULL,
    scope text NOT NULL,
    asset_code text,
    action text NOT NULL,
    reason text,
    source text DEFAULT 'manual'::text NOT NULL,
    operator text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_control_switch_events_action_check CHECK ((action = ANY (ARRAY['enabled'::text, 'disabled'::text])))
);

-- Name: risk_control_switch_events_event_id_seq; Type: SEQUENCE
CREATE SEQUENCE risk_control_switch_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: risk_control_switch_events_event_id_seq; Type: SEQUENCE OWNED BY
ALTER SEQUENCE risk_control_switch_events_event_id_seq OWNED BY risk_control_switch_events.event_id;

-- Name: risk_control_switches; Type: TABLE
CREATE TABLE risk_control_switches (
    switch_key text NOT NULL,
    scope text NOT NULL,
    asset_code text,
    reason text,
    source text DEFAULT 'manual'::text NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_control_switches_scope_check CHECK ((scope = ANY (ARRAY['withdrawals_global'::text, 'withdrawals_asset'::text, 'api_write'::text]))),
    CONSTRAINT risk_control_switches_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'automatic'::text])))
);

-- Name: risk_market_status_overrides; Type: TABLE
CREATE TABLE risk_market_status_overrides (
    market text NOT NULL,
    status text NOT NULL,
    reason text,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_market_status_overrides_status_check CHECK ((status = ANY (ARRAY['listed'::text, 'halted'::text])))
);

-- Name: risk_surveillance_alert_events; Type: TABLE
CREATE TABLE risk_surveillance_alert_events (
    event_id uuid NOT NULL,
    alert_id uuid NOT NULL,
    action text NOT NULL,
    from_status text,
    to_status text NOT NULL,
    note text,
    actor text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT risk_surveillance_alert_events_action_check CHECK ((action = ANY (ARRAY['detected'::text, 'acknowledged'::text, 'dismissed'::text, 'reopened'::text])))
);

-- Name: risk_surveillance_alerts; Type: TABLE
CREATE TABLE risk_surveillance_alerts (
    alert_id uuid NOT NULL,
    alert_key text NOT NULL,
    type text NOT NULL,
    market text NOT NULL,
    user_id text,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    summary text NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    market_maker boolean DEFAULT false NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    first_detected_at timestamp with time zone NOT NULL,
    last_detected_at timestamp with time zone NOT NULL,
    status_note text,
    status_updated_by text,
    status_updated_at timestamp with time zone,
    CONSTRAINT risk_surveillance_alerts_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT risk_surveillance_alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'dismissed'::text]))),
    CONSTRAINT risk_surveillance_alerts_type_check CHECK ((type = ANY (ARRAY['wash_trade'::text, 'concentrated_volume'::text, 'spoofing'::text, 'price_move'::text])))
);

-- Name: risk_control_switch_events event_id; Type: DEFAULT
ALTER TABLE ONLY risk_control_switch_events ALTER COLUMN event_id SET DEFAULT nextval('risk_control_switch_events_event_id_seq'::regclass);

-- Name: risk_control_switch_events risk_control_switch_events_pkey; Type: CONSTRAINT
ALTER TABLE ONLY risk_control_switch_events
    ADD CONSTRAINT risk_control_switch_events_pkey PRIMARY KEY (event_id);

-- Name: risk_control_switches risk_control_switches_pkey; Type: CONSTRAINT
ALTER TABLE ONLY risk_control_switches
    ADD CONSTRAINT risk_control_switches_pkey PRIMARY KEY (switch_key);

-- Name: risk_market_status_overrides risk_market_status_overrides_pkey; Type: CONSTRAINT
ALTER TABLE ONLY risk_market_status_overrides
    ADD CONSTRAINT risk_market_status_overrides_pkey PRIMARY KEY (market);

-- Name: risk_surveillance_alert_events risk_surveillance_alert_events_pkey; Type: CONSTRAINT
ALTER TABLE ONLY risk_surveillance_alert_events
    ADD CONSTRAINT risk_surveillance_alert_events_pkey PRIMARY KEY (event_id);

-- Name: risk_surveillance_alerts risk_surveillance_alerts_alert_key_key; Type: CONSTRAINT
ALTER TABLE ONLY risk_surveillance_alerts
    ADD CONSTRAINT risk_surveillance_alerts_alert_key_key UNIQUE (alert_key);

-- Name: risk_surveillance_alerts risk_surveillance_alerts_pkey; Type: CONSTRAINT
ALTER TABLE ONLY risk_surveillance_alerts
    ADD CONSTRAINT risk_surveillance_alerts_pkey PRIMARY KEY (alert_id);

-- Name: idx_risk_control_switch_events_created_at; Type: INDEX
CREATE INDEX idx_risk_control_switch_events_created_at ON risk_control_switch_events USING btree (created_at DESC);

-- Name: idx_risk_surveillance_alert_events_alert; Type: INDEX
CREATE INDEX idx_risk_surveillance_alert_events_alert ON risk_surveillance_alert_events USING btree (alert_id, created_at);

-- Name: idx_risk_surveillance_alerts_status; Type: INDEX
CREATE INDEX idx_risk_surveillance_alerts_status ON risk_surveillance_alerts USING btree (status, last_detected_at DESC);

-- Name: idx_risk_surveillance_alerts_subject; Type: INDEX
CREATE INDEX idx_risk_surveillance_alerts_subject ON risk_surveillance_alerts USING btree (type, market, user_id, last_detected_at DESC);
