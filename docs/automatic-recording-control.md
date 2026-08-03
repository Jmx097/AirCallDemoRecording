# Automatic recording control operations

This runtime can only issue `resume_recording`; it never pauses recording. The checked-in environment is staged and has no activation.

## Activation

Four independent recording secrets are mandatory: webhook authentication token, durable idempotency HMAC key, pseudonymization HMAC key, and AES-256-GCM capability key. The runtime rejects reuse by literal representation and, where encodings are comparable, decoded key material. The Ed25519 approval verification key is public and is not a fifth secret. Capability keys use `RECORDING_CAPABILITY_ACTIVE_KEY_ID` plus a canonical base64 32-byte key. Rotation syntax is `RECORDING_CAPABILITY_PREVIOUS_KEYS=old-id:BASE64,older-id:BASE64`; retain old keys until readiness reports no unknown key IDs, then remove them.

The approval authority creates an Ed25519 keypair offline. The private key is canonical base64 PKCS8 DER and must never be installed in the online runtime. The online runtime receives only the canonical base64 SPKI DER public key in `RECORDING_APPROVAL_PUBLIC_KEY`. Generate files without printing private material (existing files are never overwritten):

```sh
node recording-activation-cli.mjs keygen \
  --private /root-only/offline/recording-approval.pk8.b64 \
  --public ./recording-approval.spki.b64
```

`keygen` sets the private file to mode `0600` and the public file to `0644`. Move the private file to the offline approval system. `generate` rejects symlinks, non-regular files, files owned by another user, and private files with any group/other permissions.

An approver creates a scope containing deployment ID, policy hash, pilot hash, exact consent column `dropdown_mm5v99w5`, approver-reference hash, and expiry. Sign it only in the offline system:

```sh
node recording-activation-cli.mjs generate scope.json \
  --private-key /root-only/offline/recording-approval.pk8.b64 > approval.json
```

Verify before transfer with either a public key file or the same explicit public environment value:

```sh
node recording-activation-cli.mjs verify approval.json scope.json \
  --public-key ./recording-approval.spki.b64
# or: RECORDING_APPROVAL_PUBLIC_KEY=... node recording-activation-cli.mjs verify approval.json scope.json
```

Artifacts use canonical base64 Ed25519 signatures. Key and signature parsing rejects noncanonical base64, noncanonical DER, and non-Ed25519 key types. Expiry and exact deployment/policy/pilot/consent scope checks are unchanged.

Use the reviewed administrative CLI; do not construct a store or run ad hoc SQL during the change window:

```sh
node recording-control-admin.mjs activate --artifact ./approval.json --correlation 0123456789abcdef
node recording-control-admin.mjs disable --reason emergency_disable --correlation 0123456789abcdef
# planned stop:
node recording-control-admin.mjs disable --reason maintenance_disable --correlation 0123456789abcdef
```

Correlations are 8–64 lowercase hexadecimal characters. Activation reads and validates the complete runtime environment, requires `envArmed=true`, rejects symlink/non-regular/malformed/non-object artifacts and artifacts over 64 KiB, then calls `activateWithAttestation` with the exact runtime keyring, public approval key, database, and scope. `setActionsEnabled(true)` still always throws; there is no non-attested enable command. Success output contains only `actionsEnabled` and `controlEpoch`.

The disable command is the break-glass path. It requires only `AIRCALL_CONTROL_DATABASE_URL`, not the rest of runtime configuration or an approval artifact. It takes a PostgreSQL transaction advisory lock and the singleton control-row lock in a serializable transaction, sets false, increments `control_epoch`, and appends the matching reason/correlation audit row before commit. Errors are fixed/redacted and fail closed. Every enable or disable increments `control_epoch`; a new deployment cannot inherit a prior TRUE value.

## Dispatch safety and incident handling

Claimed work is epoch-bound. Fresh Sales Board lookup and current policy run before `prepareDispatch`. Prepare durably changes the row to `dispatching`; that status is never leased again. `executeWithDispatchFence` share-locks the control row while the provider request is in flight. Therefore a disable that commits first prevents dispatch; a disable waiting behind the shared lock documents an already in-flight request. Provider errors and timeouts become `outcome_unknown` and are never retried. A crash after prepare remains `dispatching`. Operators must reconcile both statuses manually.

Monitoring (non-PII):

```sql
SELECT status, count(*) FROM recording_action_outbox GROUP BY status;
SELECT action_key_hash, status, updated_at, failure_code
FROM recording_action_outbox WHERE status IN ('dispatching','outcome_unknown') ORDER BY updated_at;
SELECT key_id, count(*) FROM recording_action_capabilities GROUP BY key_id;
SELECT actions_enabled, control_epoch, changed_at FROM recording_action_control;
```

Do not reset either unresolved status to pending. Reconcile against provider records, record the incident externally, then use a separately reviewed manual reconciliation procedure.

## Readiness

`staged` is HTTP 200 only with healthy DB/schema, DB actions false, and no provider/worker authority. `ready_for_activation` is disabled but env-armed. `actively_controlling` additionally requires an exact unexpired activation, current policy/pilot/schema, provider and worker health, known capability keys, and zero unresolved `dispatching`/`outcome_unknown` rows. Output contains freshness and booleans/count-derived checks only—no identifiers or secrets.
