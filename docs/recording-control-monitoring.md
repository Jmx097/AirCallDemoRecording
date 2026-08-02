# Recording control monitoring and retention operations

`recording-control-ops.mjs` is the non-PII operations interface for the Timberline recording controller. It reads only `AIRCALL_CONTROL_DATABASE_URL`, controller scope metadata, and capability **key IDs**. It never reads capability key material and never calls Aircall, Monday, or any other API.

## Status

```sh
node recording-control-ops.mjs status
```

The command writes one fixed-shape JSON object. Output is limited to booleans, aggregate counts, integer age/freshness values, and a fixed error code. It does **not** emit action hashes, deployment or pilot identifiers, correlations, database URLs, ciphertext, secrets, timestamps, or exception text.

Exit status is nonzero if any of these conditions is observed:

- actions are enabled without an unexpired activation matching the current control epoch and exact deployment/policy/pilot/consent scope (when all scope inputs are available);
- one or more actions are `dispatching` or `outcome_unknown`;
- a `pending` or `retry_scheduled` action has been available for at least 300 seconds;
- a capability uses a key ID not listed by `RECORDING_CAPABILITY_ACTIVE_KEY_ID` or `RECORDING_CAPABILITY_PREVIOUS_KEYS`;
- the database is unavailable, the singleton control row is absent, or a database result is malformed.

If scope inputs are incomplete, `scopeAvailable` is false and activation matching is not asserted. This is not equivalent to a matching activation. If no known capability key IDs are configured, every stored capability is counted as unknown.

Recommended alerts:

- page immediately on `dispatching`, `outcomeUnknown`, or `unknownCapabilityKey` above zero;
- page on `actionsEnabled=true` with `activationMatches=false` when `scopeAvailable=true`;
- investigate `stalePendingRetry` above zero and increasing `oldestPendingRetryAgeSeconds`;
- alert on any nonzero process exit or `database=false`.

Run status under a dedicated database role with `CONNECT`, schema `USAGE`, and `SELECT` on the six `recording_action_*` operational tables only. Do not copy command output together with environment dumps or database logs.

## Retention purge

The retention period is intentionally fixed in code at exactly **30 days**, calculated once from PostgreSQL `clock_timestamp()` inside the transaction. There is no days/retention override.

Preview (default and safe for routine review):

```sh
node recording-control-ops.mjs purge-retention
```

Execute only after reviewing the aggregate preview:

```sh
node recording-control-ops.mjs purge-retention --execute
```

Both modes acquire a PostgreSQL transaction-scoped advisory lock, lock the singleton control row, and run at serializable isolation. Preview performs the same deletes and then rolls back; execute commits. Output contains only aggregate deletion counts.

The purge may remove:

- capabilities belonging to `succeeded`, `failed`, or `canceled` actions completed before the cutoff;
- those same old action outbox rows;
- decisions older than the cutoff after they have no outbox reference;
- activations expired before the cutoff, except an activation at the current control epoch;
- control audit rows older than the cutoff, except a row at the current control epoch.

It never deletes `pending`, `leased`, `retry_scheduled`, `dispatching`, or `outcome_unknown` actions. The current singleton control row is never deleted. Current-epoch and unexpired activations are preserved.

The execute role needs only `CONNECT`, schema `USAGE`, `SELECT`/`DELETE` on these tables, and sequence access is not required. Keep execute privileges separate from the read-only monitoring role. Schedule preview first and treat unexpected count changes as a reason not to execute.

## Testing safely

Unit tests use fake clients. The PostgreSQL integration test is opt-in and deliberately ignores `AIRCALL_CONTROL_DATABASE_URL`:

```sh
AIRCALL_CONTROL_OPS_TEST_DATABASE_URL='<disposable database URL>' \
  node --test recording-control-ops.test.mjs
```

The integration test creates and drops a unique temporary schema. Point this variable only at a disposable PostgreSQL instance; never at production or a shared controller database.
