-- ledger-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

create extension if not exists "pgcrypto";

-- Name: accounts; Type: TABLE
CREATE TABLE accounts (
    account_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    account_type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: balance_locks; Type: TABLE
CREATE TABLE balance_locks (
    lock_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    asset_code text NOT NULL,
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    amount numeric(36,18) NOT NULL,
    status text DEFAULT 'locked'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    consumed_at timestamp with time zone,
    remaining_amount numeric(36,18) NOT NULL,
    CONSTRAINT balance_locks_amount_check CHECK ((amount > (0)::numeric))
);

-- Name: balances; Type: TABLE
CREATE TABLE balances (
    balance_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    asset_code text NOT NULL,
    available numeric(36,18) DEFAULT 0 NOT NULL,
    locked numeric(36,18) DEFAULT 0 NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: ledger_entries; Type: TABLE
CREATE TABLE ledger_entries (
    entry_id uuid DEFAULT gen_random_uuid() NOT NULL,
    journal_id uuid NOT NULL,
    account_id uuid NOT NULL,
    asset_code text NOT NULL,
    direction text NOT NULL,
    amount numeric(36,18) NOT NULL,
    reference_type text NOT NULL,
    reference_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_entries_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT ledger_entries_direction_check CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text])))
);

-- Name: ledger_journals; Type: TABLE
CREATE TABLE ledger_journals (
    journal_id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_type text NOT NULL,
    business_id text NOT NULL,
    idempotency_key text NOT NULL,
    trace_id text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: ledger_reconciliation_runs; Type: TABLE
CREATE TABLE ledger_reconciliation_runs (
    run_id uuid NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    balance_mismatch_count integer DEFAULT 0 NOT NULL,
    order_lock_mismatch_count integer DEFAULT 0 NOT NULL,
    mismatched_assets text[] DEFAULT '{}'::text[] NOT NULL,
    tripped_assets text[] DEFAULT '{}'::text[] NOT NULL,
    report jsonb DEFAULT '{}'::jsonb NOT NULL
);

-- Name: outbox_events; Type: TABLE
CREATE TABLE outbox_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publish_attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    last_attempted_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    dead_lettered_at timestamp with time zone
);

-- Name: accounts accounts_pkey; Type: CONSTRAINT
ALTER TABLE ONLY accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (account_id);

-- Name: balance_locks balance_locks_pkey; Type: CONSTRAINT
ALTER TABLE ONLY balance_locks
    ADD CONSTRAINT balance_locks_pkey PRIMARY KEY (lock_id);

-- Name: balance_locks balance_locks_reference_type_reference_id_account_id_asset__key; Type: CONSTRAINT
ALTER TABLE ONLY balance_locks
    ADD CONSTRAINT balance_locks_reference_type_reference_id_account_id_asset__key UNIQUE (reference_type, reference_id, account_id, asset_code);

-- Name: balances balances_account_id_asset_code_key; Type: CONSTRAINT
ALTER TABLE ONLY balances
    ADD CONSTRAINT balances_account_id_asset_code_key UNIQUE (account_id, asset_code);

-- Name: balances balances_pkey; Type: CONSTRAINT
ALTER TABLE ONLY balances
    ADD CONSTRAINT balances_pkey PRIMARY KEY (balance_id);

-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT
ALTER TABLE ONLY ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (entry_id);

-- Name: ledger_journals ledger_journals_idempotency_key_key; Type: CONSTRAINT
ALTER TABLE ONLY ledger_journals
    ADD CONSTRAINT ledger_journals_idempotency_key_key UNIQUE (idempotency_key);

-- Name: ledger_journals ledger_journals_pkey; Type: CONSTRAINT
ALTER TABLE ONLY ledger_journals
    ADD CONSTRAINT ledger_journals_pkey PRIMARY KEY (journal_id);

-- Name: ledger_reconciliation_runs ledger_reconciliation_runs_pkey; Type: CONSTRAINT
ALTER TABLE ONLY ledger_reconciliation_runs
    ADD CONSTRAINT ledger_reconciliation_runs_pkey PRIMARY KEY (run_id);

-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT
ALTER TABLE ONLY outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (event_id);

-- Name: idx_ledger_entries_account_asset; Type: INDEX
CREATE INDEX idx_ledger_entries_account_asset ON ledger_entries USING btree (account_id, asset_code);

-- Name: idx_ledger_entries_journal_id; Type: INDEX
CREATE INDEX idx_ledger_entries_journal_id ON ledger_entries USING btree (journal_id);

-- Name: idx_ledger_reconciliation_runs_started_at; Type: INDEX
CREATE INDEX idx_ledger_reconciliation_runs_started_at ON ledger_reconciliation_runs USING btree (started_at DESC);

-- Name: idx_outbox_events_publishable; Type: INDEX
CREATE INDEX idx_outbox_events_publishable ON outbox_events USING btree (created_at, next_attempt_at) WHERE ((published_at IS NULL) AND (dead_lettered_at IS NULL));

-- Name: balance_locks balance_locks_account_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY balance_locks
    ADD CONSTRAINT balance_locks_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(account_id);

-- Name: balances balances_account_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY balances
    ADD CONSTRAINT balances_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(account_id);

-- Name: ledger_entries ledger_entries_account_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY ledger_entries
    ADD CONSTRAINT ledger_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(account_id);

-- Name: ledger_entries ledger_entries_journal_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY ledger_entries
    ADD CONSTRAINT ledger_entries_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES ledger_journals(journal_id);
