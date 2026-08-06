-- Post-asset two-party retention finalizer. Raw call identifiers, phones, timestamps,
-- and Monday item IDs are encrypted in retention_decision_capabilities; audit tables use hashes only.
CREATE TABLE IF NOT EXISTS timberline_retention_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS timberline_retention_decisions (
  correlation char(64) PRIMARY KEY CHECK (correlation ~ '^[0-9a-f]{64}$'),
  provider_call_key_hash char(64) NOT NULL UNIQUE CHECK (provider_call_key_hash ~ '^[0-9a-f]{64}$'),
  policy_outcome text NOT NULL CHECK (policy_outcome = 'two_party_delete'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS timberline_retention_capabilities (
  correlation char(64) PRIMARY KEY REFERENCES timberline_retention_decisions(correlation) ON DELETE CASCADE,
  key_id text NOT NULL, ciphertext bytea NOT NULL, iv bytea NOT NULL CHECK (octet_length(iv)=12), auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS timberline_retention_actions (
  id bigserial PRIMARY KEY,
  asset_key char(64) NOT NULL UNIQUE CHECK (asset_key ~ '^[0-9a-f]{64}$'),
  correlation char(64) NOT NULL UNIQUE REFERENCES timberline_retention_decisions(correlation),
  status text NOT NULL CHECK (status IN ('delete_pending','deleting','delete_requested','confirming','delete_confirmed','clearing','monday_link_cleared','exception')),
  lease_token uuid,
  lease_expires_at timestamptz,
  exception_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS timberline_retention_actions_ready_idx ON timberline_retention_actions(created_at) WHERE status IN ('delete_pending','delete_requested','delete_confirmed');
INSERT INTO timberline_retention_schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;
