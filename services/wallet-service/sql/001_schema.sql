-- wallet-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

create extension if not exists "pgcrypto";

-- Name: deposits; Type: TABLE
CREATE TABLE deposits (
    deposit_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset_code text NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    tx_hash text NOT NULL,
    amount numeric(36,18) NOT NULL,
    block_number bigint,
    confirmations integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone,
    credited_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ledger_account_id uuid,
    ledger_journal_id uuid,
    CONSTRAINT deposits_amount_check CHECK ((amount > (0)::numeric))
);

-- Name: proof_of_reserves_leaves; Type: TABLE
CREATE TABLE proof_of_reserves_leaves (
    snapshot_id uuid NOT NULL,
    user_id uuid NOT NULL,
    leaf_index integer NOT NULL,
    nonce text NOT NULL,
    user_hash text NOT NULL,
    balances jsonb NOT NULL,
    leaf_hash text NOT NULL,
    proof jsonb NOT NULL
);

-- Name: proof_of_reserves_snapshots; Type: TABLE
CREATE TABLE proof_of_reserves_snapshots (
    snapshot_id uuid NOT NULL,
    merkle_root text NOT NULL,
    leaf_count integer NOT NULL,
    tree_depth integer NOT NULL,
    assets jsonb DEFAULT '[]'::jsonb NOT NULL,
    generated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: treasury_sweep_deposits; Type: TABLE
CREATE TABLE treasury_sweep_deposits (
    deposit_id uuid NOT NULL,
    transfer_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: treasury_transfers; Type: TABLE
CREATE TABLE treasury_transfers (
    transfer_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    trigger text NOT NULL,
    asset_code text NOT NULL,
    network text NOT NULL,
    amount numeric(36,18) NOT NULL,
    from_wallet text NOT NULL,
    to_wallet text NOT NULL,
    from_address text,
    to_address text NOT NULL,
    idempotency_key text NOT NULL,
    reason text,
    requested_by text NOT NULL,
    reviewed_by text,
    review_note text,
    custody_transfer_id text,
    provider_name text,
    tx_hash text,
    confirmations integer DEFAULT 0 NOT NULL,
    block_number bigint,
    last_error text,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    broadcasted_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    rejected_at timestamp with time zone,
    failed_at timestamp with time zone,
    CONSTRAINT treasury_transfers_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT treasury_transfers_from_wallet_check CHECK ((from_wallet = ANY (ARRAY['external'::text, 'deposit'::text, 'hot'::text, 'cold'::text]))),
    CONSTRAINT treasury_transfers_kind_check CHECK ((kind = ANY (ARRAY['genesis'::text, 'sweep'::text, 'rebalance_to_cold'::text, 'rebalance_to_hot'::text]))),
    CONSTRAINT treasury_transfers_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'broadcasted'::text, 'confirmed'::text, 'rejected'::text, 'failed'::text]))),
    CONSTRAINT treasury_transfers_to_wallet_check CHECK ((to_wallet = ANY (ARRAY['hot'::text, 'cold'::text])))
);

-- Name: wallet_addresses; Type: TABLE
CREATE TABLE wallet_addresses (
    wallet_address_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset_code text NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    tag text,
    provider_account_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ledger_account_id uuid
);

-- Name: wallet_notifications; Type: TABLE
CREATE TABLE wallet_notifications (
    notification_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    withdrawal_id uuid,
    event_type text NOT NULL,
    channel text NOT NULL,
    status text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    delivery_receipt jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_attempted_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    read_at timestamp with time zone,
    deposit_id uuid,
    CONSTRAINT wallet_notifications_channel_check CHECK ((channel = 'inbox'::text)),
    CONSTRAINT wallet_notifications_event_type_check CHECK ((event_type = ANY (ARRAY['withdrawal.requested'::text, 'withdrawal.approved'::text, 'withdrawal.rejected'::text, 'withdrawal.broadcasted'::text, 'withdrawal.confirmed'::text, 'deposit.credited'::text, 'security.new_device_login'::text]))),
    CONSTRAINT wallet_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text]))),
    CONSTRAINT wallet_notifications_subject_check CHECK (((withdrawal_id IS NOT NULL) OR (deposit_id IS NOT NULL) OR (event_type ~~ 'security.%'::text)))
);

-- Name: withdrawal_address_blacklist; Type: TABLE
CREATE TABLE withdrawal_address_blacklist (
    entry_id uuid DEFAULT gen_random_uuid() NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    category text NOT NULL,
    reason text NOT NULL,
    source text DEFAULT 'ops'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_by text,
    removed_at timestamp with time zone,
    removal_reason text,
    CONSTRAINT withdrawal_address_blacklist_category_check CHECK ((category = ANY (ARRAY['sanctioned'::text, 'mixer'::text, 'scam'::text, 'hack'::text, 'other'::text]))),
    CONSTRAINT withdrawal_address_blacklist_source_check CHECK ((source = ANY (ARRAY['seed'::text, 'ops'::text]))),
    CONSTRAINT withdrawal_address_blacklist_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))
);

-- Name: withdrawal_address_book; Type: TABLE
CREATE TABLE withdrawal_address_book (
    address_book_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    network text NOT NULL,
    address text NOT NULL,
    label text NOT NULL,
    is_whitelisted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: withdrawal_audit_logs; Type: TABLE
CREATE TABLE withdrawal_audit_logs (
    audit_log_id uuid DEFAULT gen_random_uuid() NOT NULL,
    withdrawal_id uuid NOT NULL,
    operator_id text,
    operator_role text,
    action text NOT NULL,
    trace_id text,
    before_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT withdrawal_audit_logs_action_check CHECK ((action = ANY (ARRAY['requested'::text, 'first_approved'::text, 'approved'::text, 'rejected'::text, 'broadcasted'::text, 'confirmed'::text])))
);

-- Name: withdrawals; Type: TABLE
CREATE TABLE withdrawals (
    withdrawal_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset_code text NOT NULL,
    network text NOT NULL,
    to_address text NOT NULL,
    amount numeric(36,18) NOT NULL,
    fee numeric(36,18) DEFAULT 0 NOT NULL,
    status text NOT NULL,
    review_status text DEFAULT 'pending'::text NOT NULL,
    custody_request_id text,
    tx_hash text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    broadcasted_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ledger_account_id uuid,
    frozen_amount numeric(36,18) DEFAULT 0 NOT NULL,
    freeze_reference_id text,
    risk_score integer,
    risk_level text,
    risk_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT withdrawals_amount_check CHECK ((amount > (0)::numeric))
);

-- Name: deposits deposits_network_tx_hash_address_key; Type: CONSTRAINT
ALTER TABLE ONLY deposits
    ADD CONSTRAINT deposits_network_tx_hash_address_key UNIQUE (network, tx_hash, address);

-- Name: deposits deposits_pkey; Type: CONSTRAINT
ALTER TABLE ONLY deposits
    ADD CONSTRAINT deposits_pkey PRIMARY KEY (deposit_id);

-- Name: proof_of_reserves_leaves proof_of_reserves_leaves_pkey; Type: CONSTRAINT
ALTER TABLE ONLY proof_of_reserves_leaves
    ADD CONSTRAINT proof_of_reserves_leaves_pkey PRIMARY KEY (snapshot_id, user_id);

-- Name: proof_of_reserves_snapshots proof_of_reserves_snapshots_pkey; Type: CONSTRAINT
ALTER TABLE ONLY proof_of_reserves_snapshots
    ADD CONSTRAINT proof_of_reserves_snapshots_pkey PRIMARY KEY (snapshot_id);

-- Name: treasury_sweep_deposits treasury_sweep_deposits_pkey; Type: CONSTRAINT
ALTER TABLE ONLY treasury_sweep_deposits
    ADD CONSTRAINT treasury_sweep_deposits_pkey PRIMARY KEY (deposit_id);

-- Name: treasury_transfers treasury_transfers_idempotency_key_key; Type: CONSTRAINT
ALTER TABLE ONLY treasury_transfers
    ADD CONSTRAINT treasury_transfers_idempotency_key_key UNIQUE (idempotency_key);

-- Name: treasury_transfers treasury_transfers_pkey; Type: CONSTRAINT
ALTER TABLE ONLY treasury_transfers
    ADD CONSTRAINT treasury_transfers_pkey PRIMARY KEY (transfer_id);

-- Name: wallet_addresses wallet_addresses_network_address_key; Type: CONSTRAINT
ALTER TABLE ONLY wallet_addresses
    ADD CONSTRAINT wallet_addresses_network_address_key UNIQUE (network, address);

-- Name: wallet_addresses wallet_addresses_pkey; Type: CONSTRAINT
ALTER TABLE ONLY wallet_addresses
    ADD CONSTRAINT wallet_addresses_pkey PRIMARY KEY (wallet_address_id);

-- Name: wallet_notifications wallet_notifications_pkey; Type: CONSTRAINT
ALTER TABLE ONLY wallet_notifications
    ADD CONSTRAINT wallet_notifications_pkey PRIMARY KEY (notification_id);

-- Name: withdrawal_address_blacklist withdrawal_address_blacklist_pkey; Type: CONSTRAINT
ALTER TABLE ONLY withdrawal_address_blacklist
    ADD CONSTRAINT withdrawal_address_blacklist_pkey PRIMARY KEY (entry_id);

-- Name: withdrawal_address_book withdrawal_address_book_pkey; Type: CONSTRAINT
ALTER TABLE ONLY withdrawal_address_book
    ADD CONSTRAINT withdrawal_address_book_pkey PRIMARY KEY (address_book_id);

-- Name: withdrawal_address_book withdrawal_address_book_user_id_network_address_key; Type: CONSTRAINT
ALTER TABLE ONLY withdrawal_address_book
    ADD CONSTRAINT withdrawal_address_book_user_id_network_address_key UNIQUE (user_id, network, address);

-- Name: withdrawal_audit_logs withdrawal_audit_logs_pkey; Type: CONSTRAINT
ALTER TABLE ONLY withdrawal_audit_logs
    ADD CONSTRAINT withdrawal_audit_logs_pkey PRIMARY KEY (audit_log_id);

-- Name: withdrawals withdrawals_pkey; Type: CONSTRAINT
ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (withdrawal_id);

-- Name: idx_deposits_network_status_detected_at; Type: INDEX
CREATE INDEX idx_deposits_network_status_detected_at ON deposits USING btree (network, status, detected_at DESC);

-- Name: idx_deposits_status; Type: INDEX
CREATE INDEX idx_deposits_status ON deposits USING btree (status);

-- Name: idx_deposits_user_detected_at; Type: INDEX
CREATE INDEX idx_deposits_user_detected_at ON deposits USING btree (user_id, detected_at DESC);

-- Name: idx_deposits_user_id; Type: INDEX
CREATE INDEX idx_deposits_user_id ON deposits USING btree (user_id);

-- Name: idx_proof_of_reserves_snapshots_created; Type: INDEX
CREATE INDEX idx_proof_of_reserves_snapshots_created ON proof_of_reserves_snapshots USING btree (created_at DESC);

-- Name: idx_treasury_sweep_deposits_transfer; Type: INDEX
CREATE INDEX idx_treasury_sweep_deposits_transfer ON treasury_sweep_deposits USING btree (transfer_id);

-- Name: idx_treasury_transfers_asset; Type: INDEX
CREATE INDEX idx_treasury_transfers_asset ON treasury_transfers USING btree (asset_code, kind, status);

-- Name: idx_treasury_transfers_status; Type: INDEX
CREATE INDEX idx_treasury_transfers_status ON treasury_transfers USING btree (status, created_at DESC);

-- Name: idx_treasury_transfers_tx_hash; Type: INDEX
CREATE INDEX idx_treasury_transfers_tx_hash ON treasury_transfers USING btree (network, tx_hash);

-- Name: idx_wallet_notifications_delivery_queue; Type: INDEX
CREATE INDEX idx_wallet_notifications_delivery_queue ON wallet_notifications USING btree (status, next_attempt_at, created_at);

-- Name: idx_wallet_notifications_status; Type: INDEX
CREATE INDEX idx_wallet_notifications_status ON wallet_notifications USING btree (status, created_at DESC);

-- Name: idx_wallet_notifications_user_id; Type: INDEX
CREATE INDEX idx_wallet_notifications_user_id ON wallet_notifications USING btree (user_id, created_at DESC);

-- Name: idx_wallet_notifications_user_unread; Type: INDEX
CREATE INDEX idx_wallet_notifications_user_unread ON wallet_notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);

-- Name: idx_wallet_notifications_withdrawal_id; Type: INDEX
CREATE INDEX idx_wallet_notifications_withdrawal_id ON wallet_notifications USING btree (withdrawal_id, created_at DESC);

-- Name: idx_withdrawal_address_blacklist_created_at; Type: INDEX
CREATE INDEX idx_withdrawal_address_blacklist_created_at ON withdrawal_address_blacklist USING btree (created_at DESC);

-- Name: idx_withdrawal_address_book_user_created_at; Type: INDEX
CREATE INDEX idx_withdrawal_address_book_user_created_at ON withdrawal_address_book USING btree (user_id, created_at DESC);

-- Name: idx_withdrawal_address_book_whitelist_lookup; Type: INDEX
CREATE INDEX idx_withdrawal_address_book_whitelist_lookup ON withdrawal_address_book USING btree (user_id, network, address) WHERE (is_whitelisted = true);

-- Name: idx_withdrawal_audit_logs_action; Type: INDEX
CREATE INDEX idx_withdrawal_audit_logs_action ON withdrawal_audit_logs USING btree (action, created_at DESC);

-- Name: idx_withdrawal_audit_logs_withdrawal_id; Type: INDEX
CREATE INDEX idx_withdrawal_audit_logs_withdrawal_id ON withdrawal_audit_logs USING btree (withdrawal_id, created_at DESC);

-- Name: idx_withdrawals_ledger_account_id; Type: INDEX
CREATE INDEX idx_withdrawals_ledger_account_id ON withdrawals USING btree (ledger_account_id);

-- Name: idx_withdrawals_network_tx_hash; Type: INDEX
CREATE INDEX idx_withdrawals_network_tx_hash ON withdrawals USING btree (network, tx_hash) WHERE (tx_hash IS NOT NULL);

-- Name: idx_withdrawals_review_queue; Type: INDEX
CREATE INDEX idx_withdrawals_review_queue ON withdrawals USING btree (review_status, status, requested_at DESC);

-- Name: idx_withdrawals_risk_level; Type: INDEX
CREATE INDEX idx_withdrawals_risk_level ON withdrawals USING btree (risk_level, requested_at DESC) WHERE (risk_level IS NOT NULL);

-- Name: idx_withdrawals_status; Type: INDEX
CREATE INDEX idx_withdrawals_status ON withdrawals USING btree (status);

-- Name: idx_withdrawals_user_id; Type: INDEX
CREATE INDEX idx_withdrawals_user_id ON withdrawals USING btree (user_id);

-- Name: idx_withdrawals_user_requested_at; Type: INDEX
CREATE INDEX idx_withdrawals_user_requested_at ON withdrawals USING btree (user_id, requested_at DESC);

-- Name: idx_withdrawals_user_to_address; Type: INDEX
CREATE INDEX idx_withdrawals_user_to_address ON withdrawals USING btree (user_id, network, to_address);

-- Name: uq_wallet_notifications_deposit_event; Type: INDEX
CREATE UNIQUE INDEX uq_wallet_notifications_deposit_event ON wallet_notifications USING btree (deposit_id, event_type) WHERE (deposit_id IS NOT NULL);

-- Name: uq_withdrawal_address_blacklist_active; Type: INDEX
CREATE UNIQUE INDEX uq_withdrawal_address_blacklist_active ON withdrawal_address_blacklist USING btree (network, address) WHERE (status = 'active'::text);

-- Name: proof_of_reserves_leaves proof_of_reserves_leaves_snapshot_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY proof_of_reserves_leaves
    ADD CONSTRAINT proof_of_reserves_leaves_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES proof_of_reserves_snapshots(snapshot_id) ON DELETE CASCADE;

-- Name: treasury_sweep_deposits treasury_sweep_deposits_transfer_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY treasury_sweep_deposits
    ADD CONSTRAINT treasury_sweep_deposits_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES treasury_transfers(transfer_id) ON DELETE CASCADE;

-- Name: wallet_notifications wallet_notifications_deposit_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY wallet_notifications
    ADD CONSTRAINT wallet_notifications_deposit_id_fkey FOREIGN KEY (deposit_id) REFERENCES deposits(deposit_id) ON DELETE CASCADE;

-- Name: wallet_notifications wallet_notifications_withdrawal_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY wallet_notifications
    ADD CONSTRAINT wallet_notifications_withdrawal_id_fkey FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(withdrawal_id) ON DELETE CASCADE;

-- Name: withdrawal_audit_logs withdrawal_audit_logs_withdrawal_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY withdrawal_audit_logs
    ADD CONSTRAINT withdrawal_audit_logs_withdrawal_id_fkey FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(withdrawal_id) ON DELETE CASCADE;
