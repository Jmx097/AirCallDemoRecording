-- Durable, redacted VoiceAuth override evidence. A confirmed override blocks post-asset
-- deletion and Monday recording-link clearing for the exact provider call correlation.
CREATE TABLE IF NOT EXISTS timberline_voiceauth_overrides (
  provider_call_key_hash char(64) PRIMARY KEY CHECK (provider_call_key_hash ~ '^[0-9a-f]{64}$'),
  event_key_hash char(64) NOT NULL UNIQUE CHECK (event_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE timberline_retention_actions DROP CONSTRAINT IF EXISTS timberline_retention_actions_status_check;
ALTER TABLE timberline_retention_actions ADD CONSTRAINT timberline_retention_actions_status_check CHECK (status IN ('delete_pending','deleting','delete_requested','confirming','delete_confirmed','clearing','monday_link_cleared','voiceauth_retained','exception'));
INSERT INTO timberline_retention_schema_versions(version) VALUES (2) ON CONFLICT DO NOTHING;
