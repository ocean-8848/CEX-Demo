-- identity-service: baseline schema (current structure).
-- Applied once by db:prepare and recorded in schema_migrations; later changes go in new numbered files.

create extension if not exists "pgcrypto";

-- Name: identity_api_keys; Type: TABLE
CREATE TABLE identity_api_keys (
    api_key_id uuid NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    key_prefix text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key_id text,
    secret_ciphertext text,
    scopes text[] DEFAULT ARRAY['read'::text, 'trade'::text] NOT NULL
);

-- Name: identity_kyc_events; Type: TABLE
CREATE TABLE identity_kyc_events (
    event_id uuid NOT NULL,
    user_id uuid NOT NULL,
    from_tier text NOT NULL,
    to_tier text NOT NULL,
    action text NOT NULL,
    request_id uuid,
    actor_id text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_kyc_events_action_check CHECK ((action = ANY (ARRAY['request_approved'::text, 'request_rejected'::text, 'tier_adjusted'::text])))
);

-- Name: identity_kyc_requests; Type: TABLE
CREATE TABLE identity_kyc_requests (
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    requested_tier text NOT NULL,
    full_name text NOT NULL,
    id_number_masked text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_tier text,
    reviewed_by text,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT identity_kyc_requests_approved_tier_check CHECK ((approved_tier = ANY (ARRAY['L1'::text, 'L2'::text]))),
    CONSTRAINT identity_kyc_requests_requested_tier_check CHECK ((requested_tier = ANY (ARRAY['L1'::text, 'L2'::text]))),
    CONSTRAINT identity_kyc_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

-- Name: identity_login_events; Type: TABLE
CREATE TABLE identity_login_events (
    event_id uuid NOT NULL,
    user_id uuid,
    email text NOT NULL,
    scope text NOT NULL,
    device_id text NOT NULL,
    device_label text DEFAULT ''::text NOT NULL,
    ip_address text,
    user_agent text,
    outcome text NOT NULL,
    failure_code text,
    is_new_device boolean DEFAULT false NOT NULL,
    session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_login_events_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text, 'locked'::text])))
);

-- Name: identity_ops_sessions; Type: TABLE
CREATE TABLE identity_ops_sessions (
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    scope text DEFAULT 'ops_console'::text NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    device_id text
);

-- Name: identity_two_factor_recovery_codes; Type: TABLE
CREATE TABLE identity_two_factor_recovery_codes (
    recovery_code_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone
);

-- Name: identity_user_credentials; Type: TABLE
CREATE TABLE identity_user_credentials (
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: identity_user_devices; Type: TABLE
CREATE TABLE identity_user_devices (
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    device_label text DEFAULT ''::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ip_address text,
    last_user_agent text,
    login_count integer DEFAULT 0 NOT NULL,
    flagged_new boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone
);

-- Name: identity_user_roles; Type: TABLE
CREATE TABLE identity_user_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: identity_users; Type: TABLE
CREATE TABLE identity_users (
    user_id uuid NOT NULL,
    email text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    user_type text DEFAULT 'customer'::text NOT NULL,
    status_reason text,
    status_updated_at timestamp with time zone,
    kyc_tier text DEFAULT 'unverified'::text NOT NULL,
    kyc_tier_updated_at timestamp with time zone
);

-- Name: user_two_factor_profiles; Type: TABLE
CREATE TABLE user_two_factor_profiles (
    user_id uuid NOT NULL,
    pending_secret text,
    secret text,
    issuer text DEFAULT 'Web3 CEX'::text NOT NULL,
    label text,
    enabled boolean DEFAULT false NOT NULL,
    enabled_at timestamp with time zone,
    last_verified_counter bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone
);

-- Name: identity_api_keys identity_api_keys_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_api_keys
    ADD CONSTRAINT identity_api_keys_pkey PRIMARY KEY (api_key_id);

-- Name: identity_api_keys identity_api_keys_token_hash_key; Type: CONSTRAINT
ALTER TABLE ONLY identity_api_keys
    ADD CONSTRAINT identity_api_keys_token_hash_key UNIQUE (token_hash);

-- Name: identity_kyc_events identity_kyc_events_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_kyc_events
    ADD CONSTRAINT identity_kyc_events_pkey PRIMARY KEY (event_id);

-- Name: identity_kyc_requests identity_kyc_requests_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_kyc_requests
    ADD CONSTRAINT identity_kyc_requests_pkey PRIMARY KEY (request_id);

-- Name: identity_login_events identity_login_events_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_login_events
    ADD CONSTRAINT identity_login_events_pkey PRIMARY KEY (event_id);

-- Name: identity_ops_sessions identity_ops_sessions_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_ops_sessions
    ADD CONSTRAINT identity_ops_sessions_pkey PRIMARY KEY (session_id);

-- Name: identity_ops_sessions identity_ops_sessions_token_hash_key; Type: CONSTRAINT
ALTER TABLE ONLY identity_ops_sessions
    ADD CONSTRAINT identity_ops_sessions_token_hash_key UNIQUE (token_hash);

-- Name: identity_two_factor_recovery_codes identity_two_factor_recovery_codes_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_two_factor_recovery_codes
    ADD CONSTRAINT identity_two_factor_recovery_codes_pkey PRIMARY KEY (recovery_code_id);

-- Name: identity_two_factor_recovery_codes identity_two_factor_recovery_codes_user_id_code_hash_key; Type: CONSTRAINT
ALTER TABLE ONLY identity_two_factor_recovery_codes
    ADD CONSTRAINT identity_two_factor_recovery_codes_user_id_code_hash_key UNIQUE (user_id, code_hash);

-- Name: identity_user_credentials identity_user_credentials_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_user_credentials
    ADD CONSTRAINT identity_user_credentials_pkey PRIMARY KEY (user_id);

-- Name: identity_user_devices identity_user_devices_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_user_devices
    ADD CONSTRAINT identity_user_devices_pkey PRIMARY KEY (user_id, device_id);

-- Name: identity_user_roles identity_user_roles_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_user_roles
    ADD CONSTRAINT identity_user_roles_pkey PRIMARY KEY (user_id, role);

-- Name: identity_users identity_users_pkey; Type: CONSTRAINT
ALTER TABLE ONLY identity_users
    ADD CONSTRAINT identity_users_pkey PRIMARY KEY (user_id);

-- Name: user_two_factor_profiles user_two_factor_profiles_pkey; Type: CONSTRAINT
ALTER TABLE ONLY user_two_factor_profiles
    ADD CONSTRAINT user_two_factor_profiles_pkey PRIMARY KEY (user_id);

-- Name: idx_identity_api_keys_key_id; Type: INDEX
CREATE UNIQUE INDEX idx_identity_api_keys_key_id ON identity_api_keys USING btree (key_id) WHERE (key_id IS NOT NULL);

-- Name: idx_identity_api_keys_status; Type: INDEX
CREATE INDEX idx_identity_api_keys_status ON identity_api_keys USING btree (status, revoked_at);

-- Name: idx_identity_api_keys_user_id; Type: INDEX
CREATE INDEX idx_identity_api_keys_user_id ON identity_api_keys USING btree (user_id, created_at DESC);

-- Name: idx_identity_kyc_events_user; Type: INDEX
CREATE INDEX idx_identity_kyc_events_user ON identity_kyc_events USING btree (user_id, created_at DESC);

-- Name: idx_identity_kyc_requests_status; Type: INDEX
CREATE INDEX idx_identity_kyc_requests_status ON identity_kyc_requests USING btree (status, created_at DESC);

-- Name: idx_identity_kyc_requests_user; Type: INDEX
CREATE INDEX idx_identity_kyc_requests_user ON identity_kyc_requests USING btree (user_id, created_at DESC);

-- Name: idx_identity_login_events_new_device; Type: INDEX
CREATE INDEX idx_identity_login_events_new_device ON identity_login_events USING btree (user_id, created_at DESC) WHERE ((is_new_device = true) AND (outcome = 'success'::text));

-- Name: idx_identity_login_events_user_created; Type: INDEX
CREATE INDEX idx_identity_login_events_user_created ON identity_login_events USING btree (user_id, created_at DESC);

-- Name: idx_identity_ops_sessions_active; Type: INDEX
CREATE INDEX idx_identity_ops_sessions_active ON identity_ops_sessions USING btree (expires_at, revoked_at);

-- Name: idx_identity_ops_sessions_scope_active; Type: INDEX
CREATE INDEX idx_identity_ops_sessions_scope_active ON identity_ops_sessions USING btree (scope, expires_at, revoked_at);

-- Name: idx_identity_ops_sessions_user_device; Type: INDEX
CREATE INDEX idx_identity_ops_sessions_user_device ON identity_ops_sessions USING btree (user_id, device_id) WHERE (revoked_at IS NULL);

-- Name: idx_identity_ops_sessions_user_id; Type: INDEX
CREATE INDEX idx_identity_ops_sessions_user_id ON identity_ops_sessions USING btree (user_id);

-- Name: idx_identity_two_factor_recovery_codes_user; Type: INDEX
CREATE INDEX idx_identity_two_factor_recovery_codes_user ON identity_two_factor_recovery_codes USING btree (user_id, used_at);

-- Name: idx_identity_user_roles_role; Type: INDEX
CREATE INDEX idx_identity_user_roles_role ON identity_user_roles USING btree (role);

-- Name: idx_identity_users_email_ci; Type: INDEX
CREATE UNIQUE INDEX idx_identity_users_email_ci ON identity_users USING btree (lower(email)) WHERE (email IS NOT NULL);

-- Name: idx_identity_users_status; Type: INDEX
CREATE INDEX idx_identity_users_status ON identity_users USING btree (status);

-- Name: identity_api_keys identity_api_keys_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_api_keys
    ADD CONSTRAINT identity_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_kyc_events identity_kyc_events_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_kyc_events
    ADD CONSTRAINT identity_kyc_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_kyc_requests identity_kyc_requests_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_kyc_requests
    ADD CONSTRAINT identity_kyc_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_login_events identity_login_events_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_login_events
    ADD CONSTRAINT identity_login_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_ops_sessions identity_ops_sessions_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_ops_sessions
    ADD CONSTRAINT identity_ops_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_two_factor_recovery_codes identity_two_factor_recovery_codes_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_two_factor_recovery_codes
    ADD CONSTRAINT identity_two_factor_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_user_credentials identity_user_credentials_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_user_credentials
    ADD CONSTRAINT identity_user_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_user_devices identity_user_devices_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_user_devices
    ADD CONSTRAINT identity_user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: identity_user_roles identity_user_roles_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY identity_user_roles
    ADD CONSTRAINT identity_user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;

-- Name: user_two_factor_profiles user_two_factor_profiles_user_id_fkey; Type: FK CONSTRAINT
ALTER TABLE ONLY user_two_factor_profiles
    ADD CONSTRAINT user_two_factor_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity_users(user_id) ON DELETE CASCADE;
