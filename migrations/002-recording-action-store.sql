-- Recording controller schema v2. Apply after 001-consent-decision-store.sql.
-- No plaintext call, phone, Monday item, evidence, credential, or webhook payload is stored.
CREATE TABLE IF NOT EXISTS recording_action_schema_versions (
  version integer PRIMARY KEY,
  migration_sha256 char(64) NOT NULL CHECK (migration_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS recording_action_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  actions_enabled boolean NOT NULL DEFAULT false,
  control_epoch bigint NOT NULL DEFAULT 0 CHECK (control_epoch >= 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO recording_action_control(singleton, actions_enabled, control_epoch)
VALUES (true, false, 0) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS recording_action_activations (
  deployment_hash char(64) PRIMARY KEY CHECK (deployment_hash ~ '^[0-9a-f]{64}$'),
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  pilot_hash char(64) NOT NULL CHECK (pilot_hash ~ '^[0-9a-f]{64}$'),
  consent_column_hash char(64) NOT NULL CHECK (consent_column_hash ~ '^[0-9a-f]{64}$'),
  approver_reference_hash char(64) NOT NULL CHECK (approver_reference_hash ~ '^[0-9a-f]{64}$'),
  control_epoch bigint NOT NULL CHECK (control_epoch > 0),
  expires_at timestamptz NOT NULL,
  artifact_digest char(64) NOT NULL UNIQUE CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS recording_action_control_audit (
  id bigserial PRIMARY KEY,
  actions_enabled boolean NOT NULL,
  control_epoch bigint NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('attested_enable','emergency_disable','maintenance_disable')),
  correlation varchar(64) CHECK (correlation IS NULL OR correlation ~ '^[0-9a-f]{8,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS recording_action_decisions (
  id bigserial PRIMARY KEY,
  decision_key_hash char(64) NOT NULL UNIQUE CHECK (decision_key_hash ~ '^[0-9a-f]{64}$'),
  approved boolean NOT NULL,
  reason_code text NOT NULL,
  policy_key_hash char(64) NOT NULL CHECK (policy_key_hash ~ '^[0-9a-f]{64}$'),
  evidence_digest char(64) CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  correlation varchar(64) CHECK (correlation IS NULL OR correlation ~ '^[0-9a-f]{8,64}$'),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((approved AND evidence_digest IS NOT NULL) OR (NOT approved AND evidence_digest IS NULL))
);

CREATE TABLE IF NOT EXISTS recording_action_outbox (
  action_key_hash char(64) PRIMARY KEY CHECK (action_key_hash ~ '^[0-9a-f]{64}$'),
  target_key_hash char(64) NOT NULL CHECK (target_key_hash ~ '^[0-9a-f]{64}$'),
  decision_id bigint NOT NULL REFERENCES recording_action_decisions(id),
  action_type text NOT NULL CHECK (action_type = 'resume_recording'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','leased','retry_scheduled','dispatching','succeeded','failed','outcome_unknown','canceled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  claim_epoch bigint,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN
    ('dependency_unavailable','authorization_denied','authorization_expired','unknown_key','provider_ambiguous','finalization_ambiguous','manual_cancel')),
  correlation varchar(64) CHECK (correlation IS NULL OR correlation ~ '^[0-9a-f]{8,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND claim_epoch IS NOT NULL AND completed_at IS NULL) OR
    (status = 'dispatching' AND lease_token IS NOT NULL AND claim_epoch IS NOT NULL AND completed_at IS NULL) OR
    (status IN ('pending','retry_scheduled') AND lease_token IS NULL AND lease_expires_at IS NULL AND claim_epoch IS NULL AND completed_at IS NULL) OR
    (status IN ('succeeded','failed','outcome_unknown','canceled') AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS recording_action_capabilities (
  action_key_hash char(64) PRIMARY KEY REFERENCES recording_action_outbox(action_key_hash) ON DELETE CASCADE,
  key_id varchar(64) NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 2048),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS recording_action_outbox_claim_idx ON recording_action_outbox(available_at,created_at)
  WHERE status IN ('pending','retry_scheduled','leased');
CREATE INDEX IF NOT EXISTS recording_action_reconcile_idx ON recording_action_outbox(updated_at)
  WHERE status IN ('dispatching','outcome_unknown');
CREATE INDEX IF NOT EXISTS recording_action_capability_key_idx ON recording_action_capabilities(key_id);
