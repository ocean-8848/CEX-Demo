-- ops-console: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

-- Name: ops_action_audit_logs; Type: TABLE
CREATE TABLE ops_action_audit_logs (
    audit_log_id uuid NOT NULL,
    batch_id uuid,
    operator_user_id text NOT NULL,
    operator_email text,
    operator_roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    permission text NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    request_payload jsonb,
    response_payload jsonb,
    status text NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL
);

-- Name: ops_action_audit_logs ops_action_audit_logs_pkey; Type: CONSTRAINT
ALTER TABLE ONLY ops_action_audit_logs
    ADD CONSTRAINT ops_action_audit_logs_pkey PRIMARY KEY (audit_log_id);

-- Name: idx_ops_action_audit_logs_action_started_at; Type: INDEX
CREATE INDEX idx_ops_action_audit_logs_action_started_at ON ops_action_audit_logs USING btree (action, started_at DESC);

-- Name: idx_ops_action_audit_logs_batch_id; Type: INDEX
CREATE INDEX idx_ops_action_audit_logs_batch_id ON ops_action_audit_logs USING btree (batch_id);

-- Name: idx_ops_action_audit_logs_operator_started_at; Type: INDEX
CREATE INDEX idx_ops_action_audit_logs_operator_started_at ON ops_action_audit_logs USING btree (operator_user_id, started_at DESC);

-- Name: idx_ops_action_audit_logs_status_started_at; Type: INDEX
CREATE INDEX idx_ops_action_audit_logs_status_started_at ON ops_action_audit_logs USING btree (status, started_at DESC);

-- Name: idx_ops_action_audit_logs_target_started_at; Type: INDEX
CREATE INDEX idx_ops_action_audit_logs_target_started_at ON ops_action_audit_logs USING btree (target_type, target_id, started_at DESC);
