-- order-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

-- Name: spot_fee_tier_override_audit; Type: TABLE
CREATE TABLE spot_fee_tier_override_audit (
    audit_id uuid NOT NULL,
    user_id text NOT NULL,
    action text NOT NULL,
    previous_tier text,
    tier text,
    note text NOT NULL,
    actor text NOT NULL,
    created_at timestamp with time zone NOT NULL
);

-- Name: spot_fee_tier_overrides; Type: TABLE
CREATE TABLE spot_fee_tier_overrides (
    user_id text NOT NULL,
    tier text NOT NULL,
    note text NOT NULL,
    assigned_by text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

-- Name: spot_order_automation_executions; Type: TABLE
CREATE TABLE spot_order_automation_executions (
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

-- Name: spot_order_recovery_jobs; Type: TABLE
CREATE TABLE spot_order_recovery_jobs (
    job_id uuid NOT NULL,
    order_id uuid NOT NULL,
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
    dead_lettered_at timestamp with time zone,
    last_claimed_at timestamp with time zone,
    lease_heartbeat_at timestamp with time zone,
    last_duration_ms integer,
    last_result text
);

-- Name: spot_orders; Type: TABLE
CREATE TABLE spot_orders (
    order_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    trace_id text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    market text NOT NULL,
    side text NOT NULL,
    type text NOT NULL,
    time_in_force text NOT NULL,
    price numeric(36,18) NOT NULL,
    quantity numeric(36,18) NOT NULL,
    filled_quantity numeric(36,18) NOT NULL,
    resting_quantity numeric(36,18) DEFAULT 0 NOT NULL,
    status text NOT NULL,
    lock_asset_code text NOT NULL,
    lock_amount numeric(36,18) NOT NULL,
    rejected_reason text,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    otel_trace_id text,
    post_only boolean DEFAULT false NOT NULL,
    stp_mode text,
    trigger_price numeric(36,18),
    triggered_at timestamp with time zone
);

-- Name: spot_trades; Type: TABLE
CREATE TABLE spot_trades (
    trade_id uuid NOT NULL,
    market text NOT NULL,
    price numeric(36,18) NOT NULL,
    quantity numeric(36,18) NOT NULL,
    maker_order_id uuid NOT NULL,
    taker_order_id uuid NOT NULL,
    buyer_order_id uuid NOT NULL,
    seller_order_id uuid NOT NULL,
    buyer_user_id text NOT NULL,
    seller_user_id text NOT NULL,
    buyer_account_id text NOT NULL,
    seller_account_id text NOT NULL,
    settlement_id uuid NOT NULL,
    executed_at timestamp with time zone NOT NULL,
    seller_fee_rate numeric(36,18) NOT NULL,
    execution_id text NOT NULL,
    execution_batch_id text NOT NULL,
    execution_sequence bigint NOT NULL,
    execution_batch_sequence integer NOT NULL,
    replay_cursor text NOT NULL,
    protocol_version text NOT NULL,
    buyer_fee_rate numeric(36,18) DEFAULT 0 NOT NULL,
    buyer_fee_tier text,
    seller_fee_tier text
);

-- Name: spot_fee_tier_override_audit spot_fee_tier_override_audit_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_fee_tier_override_audit
    ADD CONSTRAINT spot_fee_tier_override_audit_pkey PRIMARY KEY (audit_id);

-- Name: spot_fee_tier_overrides spot_fee_tier_overrides_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_fee_tier_overrides
    ADD CONSTRAINT spot_fee_tier_overrides_pkey PRIMARY KEY (user_id);

-- Name: spot_order_automation_executions spot_order_automation_executions_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_order_automation_executions
    ADD CONSTRAINT spot_order_automation_executions_pkey PRIMARY KEY (execution_id);

-- Name: spot_order_recovery_jobs spot_order_recovery_jobs_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_order_recovery_jobs
    ADD CONSTRAINT spot_order_recovery_jobs_pkey PRIMARY KEY (job_id);

-- Name: spot_orders spot_orders_idempotency_key_key; Type: CONSTRAINT
ALTER TABLE ONLY spot_orders
    ADD CONSTRAINT spot_orders_idempotency_key_key UNIQUE (idempotency_key);

-- Name: spot_orders spot_orders_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_orders
    ADD CONSTRAINT spot_orders_pkey PRIMARY KEY (order_id);

-- Name: spot_trades spot_trades_pkey; Type: CONSTRAINT
ALTER TABLE ONLY spot_trades
    ADD CONSTRAINT spot_trades_pkey PRIMARY KEY (trade_id);

-- Name: idx_spot_fee_tier_override_audit_user; Type: INDEX
CREATE INDEX idx_spot_fee_tier_override_audit_user ON spot_fee_tier_override_audit USING btree (user_id, created_at DESC);

-- Name: idx_spot_order_automation_executions_started_at; Type: INDEX
CREATE INDEX idx_spot_order_automation_executions_started_at ON spot_order_automation_executions USING btree (started_at DESC);

-- Name: idx_spot_order_automation_executions_type_status; Type: INDEX
CREATE INDEX idx_spot_order_automation_executions_type_status ON spot_order_automation_executions USING btree (execution_type, status, started_at DESC);

-- Name: idx_spot_order_recovery_jobs_dead_lettered_at; Type: INDEX
CREATE INDEX idx_spot_order_recovery_jobs_dead_lettered_at ON spot_order_recovery_jobs USING btree (dead_lettered_at DESC);

-- Name: idx_spot_order_recovery_jobs_lease_expires_at; Type: INDEX
CREATE INDEX idx_spot_order_recovery_jobs_lease_expires_at ON spot_order_recovery_jobs USING btree (lease_expires_at);

-- Name: idx_spot_order_recovery_jobs_lease_owner_status; Type: INDEX
CREATE INDEX idx_spot_order_recovery_jobs_lease_owner_status ON spot_order_recovery_jobs USING btree (lease_owner, status) WHERE (lease_owner IS NOT NULL);

-- Name: idx_spot_order_recovery_jobs_order_id; Type: INDEX
CREATE INDEX idx_spot_order_recovery_jobs_order_id ON spot_order_recovery_jobs USING btree (order_id, created_at DESC);

-- Name: idx_spot_order_recovery_jobs_status_next_attempt_at; Type: INDEX
CREATE INDEX idx_spot_order_recovery_jobs_status_next_attempt_at ON spot_order_recovery_jobs USING btree (status, next_attempt_at);

-- Name: idx_spot_orders_account_id_status; Type: INDEX
CREATE INDEX idx_spot_orders_account_id_status ON spot_orders USING btree (account_id, status, created_at DESC);

-- Name: idx_spot_orders_cancelled_at; Type: INDEX
CREATE INDEX idx_spot_orders_cancelled_at ON spot_orders USING btree (cancelled_at DESC) WHERE (cancelled_at IS NOT NULL);

-- Name: idx_spot_orders_pending_trigger; Type: INDEX
CREATE INDEX idx_spot_orders_pending_trigger ON spot_orders USING btree (market, created_at) WHERE (status = 'pending_trigger'::text);

-- Name: idx_spot_orders_user_id_created_at; Type: INDEX
CREATE INDEX idx_spot_orders_user_id_created_at ON spot_orders USING btree (user_id, created_at DESC);

-- Name: idx_spot_trades_buyer_user_id_executed_at; Type: INDEX
CREATE INDEX idx_spot_trades_buyer_user_id_executed_at ON spot_trades USING btree (buyer_user_id, executed_at DESC);

-- Name: idx_spot_trades_executed_at; Type: INDEX
CREATE INDEX idx_spot_trades_executed_at ON spot_trades USING btree (executed_at DESC);

-- Name: idx_spot_trades_execution_batch_id; Type: INDEX
CREATE INDEX idx_spot_trades_execution_batch_id ON spot_trades USING btree (execution_batch_id, execution_batch_sequence);

-- Name: idx_spot_trades_execution_id; Type: INDEX
CREATE UNIQUE INDEX idx_spot_trades_execution_id ON spot_trades USING btree (execution_id);

-- Name: idx_spot_trades_market_execution_sequence; Type: INDEX
CREATE INDEX idx_spot_trades_market_execution_sequence ON spot_trades USING btree (market, execution_sequence DESC);

-- Name: idx_spot_trades_seller_user_id_executed_at; Type: INDEX
CREATE INDEX idx_spot_trades_seller_user_id_executed_at ON spot_trades USING btree (seller_user_id, executed_at DESC);

-- Name: spot_order_recovery_jobs spot_order_recovery_jobs_order_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY spot_order_recovery_jobs
    ADD CONSTRAINT spot_order_recovery_jobs_order_id_fkey FOREIGN KEY (order_id) REFERENCES spot_orders(order_id);
