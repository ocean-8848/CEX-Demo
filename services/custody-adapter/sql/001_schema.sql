-- custody-adapter: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

create extension if not exists "pgcrypto";

-- Name: custody_transfer_attempts; Type: TABLE
CREATE TABLE custody_transfer_attempts (
    attempt_id uuid DEFAULT gen_random_uuid() NOT NULL,
    custody_transfer_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    action text NOT NULL,
    status text NOT NULL,
    provider_name text NOT NULL,
    tx_hash text,
    error_code text,
    error_message text,
    request_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT custody_transfer_attempts_action_check CHECK ((action = ANY (ARRAY['broadcast'::text, 'retry'::text, 'sync_status'::text]))),
    CONSTRAINT custody_transfer_attempts_attempt_number_check CHECK ((attempt_number > 0)),
    CONSTRAINT custody_transfer_attempts_status_check CHECK ((status = ANY (ARRAY['succeeded'::text, 'failed'::text])))
);

-- Name: custody_transfers; Type: TABLE
CREATE TABLE custody_transfers (
    custody_transfer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference_id text NOT NULL,
    asset_code text NOT NULL,
    network text NOT NULL,
    to_address text NOT NULL,
    amount numeric(36,18) NOT NULL,
    fee numeric(36,18) NOT NULL,
    idempotency_key text NOT NULL,
    provider_name text NOT NULL,
    provider_transfer_id text,
    status text NOT NULL,
    tx_hash text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    broadcasted_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT custody_transfers_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT custody_transfers_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT custody_transfers_fee_check CHECK ((fee >= (0)::numeric)),
    CONSTRAINT custody_transfers_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'broadcasted'::text, 'confirmed'::text, 'failed'::text])))
);

-- Name: custody_transfer_attempts custody_transfer_attempts_pkey; Type: CONSTRAINT
ALTER TABLE ONLY custody_transfer_attempts
    ADD CONSTRAINT custody_transfer_attempts_pkey PRIMARY KEY (attempt_id);

-- Name: custody_transfers custody_transfers_idempotency_key_key; Type: CONSTRAINT
ALTER TABLE ONLY custody_transfers
    ADD CONSTRAINT custody_transfers_idempotency_key_key UNIQUE (idempotency_key);

-- Name: custody_transfers custody_transfers_pkey; Type: CONSTRAINT
ALTER TABLE ONLY custody_transfers
    ADD CONSTRAINT custody_transfers_pkey PRIMARY KEY (custody_transfer_id);

-- Name: idx_custody_transfer_attempts_transfer_id; Type: INDEX
CREATE INDEX idx_custody_transfer_attempts_transfer_id ON custody_transfer_attempts USING btree (custody_transfer_id, created_at DESC);

-- Name: idx_custody_transfers_reference_id; Type: INDEX
CREATE INDEX idx_custody_transfers_reference_id ON custody_transfers USING btree (reference_id);

-- Name: idx_custody_transfers_status; Type: INDEX
CREATE INDEX idx_custody_transfers_status ON custody_transfers USING btree (status);

-- Name: idx_custody_transfers_tx_hash; Type: INDEX
CREATE INDEX idx_custody_transfers_tx_hash ON custody_transfers USING btree (network, tx_hash);

-- Name: custody_transfer_attempts custody_transfer_attempts_custody_transfer_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY custody_transfer_attempts
    ADD CONSTRAINT custody_transfer_attempts_custody_transfer_id_fkey FOREIGN KEY (custody_transfer_id) REFERENCES custody_transfers(custody_transfer_id) ON DELETE CASCADE;
