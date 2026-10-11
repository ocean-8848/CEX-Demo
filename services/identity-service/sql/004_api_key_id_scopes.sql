-- M2-4: API keys become a public key id + a secret that never leaves identity.
-- The secret is stored encrypted (AES-256-GCM) so identity can recompute the
-- HMAC; the gateway only forwards the canonical request and the signature.
alter table identity_api_keys add column if not exists key_id text;
alter table identity_api_keys add column if not exists secret_ciphertext text;
alter table identity_api_keys add column if not exists scopes text[] not null default array['read', 'trade'];

create unique index if not exists idx_identity_api_keys_key_id
  on identity_api_keys (key_id)
  where key_id is not null;
