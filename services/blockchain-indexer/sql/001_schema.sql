-- blockchain-indexer: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

create extension if not exists "pgcrypto";

-- Name: blockchain_deposit_observations; Type: TABLE
CREATE TABLE blockchain_deposit_observations (
    observation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    asset_code text NOT NULL,
    address text NOT NULL,
    tx_hash text NOT NULL,
    amount numeric(36,18) NOT NULL,
    confirmations integer DEFAULT 0 NOT NULL,
    block_number bigint,
    status text NOT NULL,
    wallet_deposit_id text,
    reorg_detected_at timestamp with time zone,
    reorged_from_block_number bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    block_hash text,
    last_manual_action text,
    last_manual_action_at timestamp with time zone,
    last_manual_action_by text,
    last_manual_action_note text,
    CONSTRAINT blockchain_deposit_observations_amount_check CHECK ((amount > (0)::numeric))
);

-- Name: blockchain_scan_cursors; Type: TABLE
CREATE TABLE blockchain_scan_cursors (
    cursor_id uuid DEFAULT gen_random_uuid() NOT NULL,
    observation_type text NOT NULL,
    network text NOT NULL,
    last_scanned_block bigint,
    last_finalized_block bigint,
    reorg_detected_at timestamp with time zone,
    reorg_detected_block bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blockchain_scan_cursors_observation_type_check CHECK ((observation_type = ANY (ARRAY['deposit'::text, 'withdrawal'::text])))
);

-- Name: blockchain_withdrawal_observations; Type: TABLE
CREATE TABLE blockchain_withdrawal_observations (
    observation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    asset_code text NOT NULL,
    tx_hash text NOT NULL,
    confirmations integer DEFAULT 0 NOT NULL,
    block_number bigint,
    status text NOT NULL,
    wallet_withdrawal_id text,
    reorg_detected_at timestamp with time zone,
    reorged_from_block_number bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    block_hash text
);

-- Name: blockchain_deposit_observations blockchain_deposit_observations_network_tx_hash_address_key; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_deposit_observations
    ADD CONSTRAINT blockchain_deposit_observations_network_tx_hash_address_key UNIQUE (network, tx_hash, address);

-- Name: blockchain_deposit_observations blockchain_deposit_observations_pkey; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_deposit_observations
    ADD CONSTRAINT blockchain_deposit_observations_pkey PRIMARY KEY (observation_id);

-- Name: blockchain_scan_cursors blockchain_scan_cursors_observation_type_network_key; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_scan_cursors
    ADD CONSTRAINT blockchain_scan_cursors_observation_type_network_key UNIQUE (observation_type, network);

-- Name: blockchain_scan_cursors blockchain_scan_cursors_pkey; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_scan_cursors
    ADD CONSTRAINT blockchain_scan_cursors_pkey PRIMARY KEY (cursor_id);

-- Name: blockchain_withdrawal_observations blockchain_withdrawal_observations_network_tx_hash_key; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_withdrawal_observations
    ADD CONSTRAINT blockchain_withdrawal_observations_network_tx_hash_key UNIQUE (network, tx_hash);

-- Name: blockchain_withdrawal_observations blockchain_withdrawal_observations_pkey; Type: CONSTRAINT
ALTER TABLE ONLY blockchain_withdrawal_observations
    ADD CONSTRAINT blockchain_withdrawal_observations_pkey PRIMARY KEY (observation_id);

-- Name: idx_blockchain_deposit_observations_block_hash; Type: INDEX
CREATE INDEX idx_blockchain_deposit_observations_block_hash ON blockchain_deposit_observations USING btree (network, block_hash);

-- Name: idx_blockchain_deposit_observations_block_number; Type: INDEX
CREATE INDEX idx_blockchain_deposit_observations_block_number ON blockchain_deposit_observations USING btree (network, block_number);

-- Name: idx_blockchain_deposit_observations_status; Type: INDEX
CREATE INDEX idx_blockchain_deposit_observations_status ON blockchain_deposit_observations USING btree (status);

-- Name: idx_blockchain_deposit_observations_status_created_at; Type: INDEX
CREATE INDEX idx_blockchain_deposit_observations_status_created_at ON blockchain_deposit_observations USING btree (status, created_at);

-- Name: idx_blockchain_withdrawal_observations_block_hash; Type: INDEX
CREATE INDEX idx_blockchain_withdrawal_observations_block_hash ON blockchain_withdrawal_observations USING btree (network, block_hash);

-- Name: idx_blockchain_withdrawal_observations_block_number; Type: INDEX
CREATE INDEX idx_blockchain_withdrawal_observations_block_number ON blockchain_withdrawal_observations USING btree (network, block_number);

-- Name: idx_blockchain_withdrawal_observations_status; Type: INDEX
CREATE INDEX idx_blockchain_withdrawal_observations_status ON blockchain_withdrawal_observations USING btree (status);
