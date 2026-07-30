-- Audit-only consent decision service durable store. No provider identifiers or payloads belong here.
CREATE TABLE IF NOT EXISTS consent_decision_service_schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consent_decision_claims (
  event_key_hash CHAR(64) PRIMARY KEY CHECK (event_key_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS consent_decision_audit_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_key_hash CHAR(64) NOT NULL REFERENCES consent_decision_claims(event_key_hash),
  outcome TEXT NOT NULL CHECK (outcome IN ('left_disabled')),
  reason TEXT NOT NULL CHECK (reason IN (
    'audit_only_eligible_one_party_state', 'not_one_party_state', 'invalid_state', 'invalid_ruleset',
    'resolver_not_found', 'resolver_not_unique', 'resolver_denied'
  )),
  correlation_prefix VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (correlation_prefix IS NULL OR correlation_prefix ~ '^[0-9a-f]{8,64}$')
);

CREATE INDEX IF NOT EXISTS consent_decision_audit_outbox_event_key_hash_idx
  ON consent_decision_audit_outbox (event_key_hash);

INSERT INTO consent_decision_service_schema_versions (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
