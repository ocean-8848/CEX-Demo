-- settlement-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

-- Name: settlement_automation_executions; Type: TABLE
CREATE TABLE settlement_automation_executions (
    execution_id text NOT NULL,
    execution_type text NOT NULL,
    status text NOT NULL,
    trigger text NOT NULL,
    market text,
    worker_id text,
    target_id text,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    duration_ms integer NOT NULL
);

-- Name: trade_event_consumer_checkpoints; Type: TABLE
CREATE TABLE trade_event_consumer_checkpoints (
    consumer_id text NOT NULL,
    event_type text NOT NULL,
    market text NOT NULL,
    schema_id text NOT NULL,
    schema_version integer NOT NULL,
    protocol_version text NOT NULL,
    last_event_id text NOT NULL,
    last_trade_id text NOT NULL,
    last_execution_sequence bigint NOT NULL,
    last_replay_cursor text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_stream_entry_id text,
    last_stream_published_at timestamp with time zone
);

-- Name: trade_settlement_recovery_jobs; Type: TABLE
CREATE TABLE trade_settlement_recovery_jobs (
    job_id uuid NOT NULL,
    trade_id uuid NOT NULL,
    market text NOT NULL,
    stage text NOT NULL,
    status text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    last_claimed_at timestamp with time zone,
    lease_heartbeat_at timestamp with time zone,
    last_duration_ms integer,
    last_result text
);

-- Name: trade_settlement_summary_rollups; Type: TABLE
CREATE TABLE trade_settlement_summary_rollups (
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    market text,
    status text NOT NULL,
    settlement_count bigint DEFAULT 0 NOT NULL,
    quantity numeric(36,18) DEFAULT 0 NOT NULL,
    quote_amount numeric(36,18) DEFAULT 0 NOT NULL,
    fee_amount numeric(36,18) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    base_fee_amount numeric(36,18) DEFAULT 0 NOT NULL
);

-- Name: trade_settlements; Type: TABLE
CREATE TABLE trade_settlements (
    settlement_id uuid NOT NULL,
    trade_id uuid NOT NULL,
    market text NOT NULL,
    price numeric(36,18) NOT NULL,
    quantity numeric(36,18) NOT NULL,
    quote_amount numeric(36,18) NOT NULL,
    fee_amount numeric(36,18) NOT NULL,
    buyer_order_id uuid NOT NULL,
    seller_order_id uuid NOT NULL,
    buyer_user_id text NOT NULL,
    seller_user_id text NOT NULL,
    buyer_account_id text NOT NULL,
    seller_account_id text NOT NULL,
    buyer_settlement_journal_id uuid,
    seller_settlement_journal_id uuid,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    execution_id text,
    execution_batch_id text,
    execution_sequence bigint,
    execution_batch_sequence integer,
    replay_cursor text,
    protocol_version text,
    buyer_fee_amount numeric(36,18) DEFAULT 0 NOT NULL,
    seller_fee_rate numeric(36,18),
    buyer_fee_rate numeric(36,18),
    seller_fee_tier text,
    buyer_fee_tier text
);

-- Name: settlement_automation_executions settlement_automation_executions_pkey; Type: CONSTRAINT
ALTER TABLE ONLY settlement_automation_executions
    ADD CONSTRAINT settlement_automation_executions_pkey PRIMARY KEY (execution_id);

-- Name: trade_event_consumer_checkpoints trade_event_consumer_checkpoints_pkey; Type: CONSTRAINT
ALTER TABLE ONLY trade_event_consumer_checkpoints
    ADD CONSTRAINT trade_event_consumer_checkpoints_pkey PRIMARY KEY (consumer_id, market);

-- Name: trade_settlement_recovery_jobs trade_settlement_recovery_jobs_pkey; Type: CONSTRAINT
ALTER TABLE ONLY trade_settlement_recovery_jobs
    ADD CONSTRAINT trade_settlement_recovery_jobs_pkey PRIMARY KEY (job_id);

-- Name: trade_settlement_recovery_jobs trade_settlement_recovery_jobs_trade_id_key; Type: CONSTRAINT
ALTER TABLE ONLY trade_settlement_recovery_jobs
    ADD CONSTRAINT trade_settlement_recovery_jobs_trade_id_key UNIQUE (trade_id);

-- Name: trade_settlement_summary_rollups trade_settlement_summary_rollups_pkey; Type: CONSTRAINT
ALTER TABLE ONLY trade_settlement_summary_rollups
    ADD CONSTRAINT trade_settlement_summary_rollups_pkey PRIMARY KEY (scope_type, scope_key, status);

-- Name: trade_settlements trade_settlements_pkey; Type: CONSTRAINT
ALTER TABLE ONLY trade_settlements
    ADD CONSTRAINT trade_settlements_pkey PRIMARY KEY (settlement_id);

-- Name: trade_settlements trade_settlements_trade_id_key; Type: CONSTRAINT
ALTER TABLE ONLY trade_settlements
    ADD CONSTRAINT trade_settlements_trade_id_key UNIQUE (trade_id);

-- Name: idx_settlement_automation_executions_started_at; Type: INDEX
CREATE INDEX idx_settlement_automation_executions_started_at ON settlement_automation_executions USING btree (started_at DESC);

-- Name: idx_settlement_automation_executions_type_status; Type: INDEX
CREATE INDEX idx_settlement_automation_executions_type_status ON settlement_automation_executions USING btree (execution_type, status, started_at DESC);

-- Name: idx_trade_event_consumer_checkpoints_stream_entry; Type: INDEX
CREATE INDEX idx_trade_event_consumer_checkpoints_stream_entry ON trade_event_consumer_checkpoints USING btree (last_stream_entry_id);

-- Name: idx_trade_event_consumer_checkpoints_updated_at; Type: INDEX
CREATE INDEX idx_trade_event_consumer_checkpoints_updated_at ON trade_event_consumer_checkpoints USING btree (updated_at DESC);

-- Name: idx_trade_settlement_recovery_jobs_lease_expires_at; Type: INDEX
CREATE INDEX idx_trade_settlement_recovery_jobs_lease_expires_at ON trade_settlement_recovery_jobs USING btree (lease_expires_at);

-- Name: idx_trade_settlement_recovery_jobs_market_created_at; Type: INDEX
CREATE INDEX idx_trade_settlement_recovery_jobs_market_created_at ON trade_settlement_recovery_jobs USING btree (market, created_at DESC);

-- Name: idx_trade_settlement_recovery_jobs_status_next_attempt_at; Type: INDEX
CREATE INDEX idx_trade_settlement_recovery_jobs_status_next_attempt_at ON trade_settlement_recovery_jobs USING btree (status, next_attempt_at);

-- Name: idx_trade_settlement_summary_rollups_market_status; Type: INDEX
CREATE INDEX idx_trade_settlement_summary_rollups_market_status ON trade_settlement_summary_rollups USING btree (market, status, updated_at DESC);

-- Name: idx_trade_settlement_summary_rollups_scope_lookup; Type: INDEX
CREATE INDEX idx_trade_settlement_summary_rollups_scope_lookup ON trade_settlement_summary_rollups USING btree (scope_type, scope_key, status, updated_at DESC);

-- Name: idx_trade_settlements_buyer_user_id; Type: INDEX
CREATE INDEX idx_trade_settlements_buyer_user_id ON trade_settlements USING btree (buyer_user_id, settled_at DESC);

-- Name: idx_trade_settlements_market_execution_sequence; Type: INDEX
CREATE INDEX idx_trade_settlements_market_execution_sequence ON trade_settlements USING btree (market, execution_sequence DESC);

-- Name: idx_trade_settlements_seller_user_id; Type: INDEX
CREATE INDEX idx_trade_settlements_seller_user_id ON trade_settlements USING btree (seller_user_id, settled_at DESC);

-- Name: trade_settlement_recovery_jobs trade_settlement_recovery_jobs_trade_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY trade_settlement_recovery_jobs
    ADD CONSTRAINT trade_settlement_recovery_jobs_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trade_settlements(trade_id);
