/**
 * Standalone contract for Aircall's per-call recording resume endpoint.
 * This module is deliberately not wired into the audit-only controller flow.
 */
const AIRCALL_API_ORIGIN = "https://api.aircall.io";
const SAFE_OPAQUE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const URL_SCHEME = /^(?:https?|ftp|file|data|javascript):/i;

export class AircallRecordingClientError extends Error {
  constructor(code, statusCategory, retryable) {
    super(`Aircall recording request failed: ${statusCategory}.`);
    this.name = "AircallRecordingClientError";
    this.code = code;
    this.statusCategory = statusCategory;
    this.retryable = retryable;
  }
}

/**
 * Creates an injected-fetch-only client for resuming recording on one call.
 * Credentials are accepted only as explicit constructor inputs and are never
 * read from the environment or emitted in errors.
 */
export function createAircallRecordingClient({ apiId, apiKey, fetch } = {}) {
  if (!nonEmptyString(apiId) || !nonEmptyString(apiKey)) {
    throw new TypeError("Aircall API ID and API key must be non-empty strings.");
  }
  if (typeof fetch !== "function") {
    throw new TypeError("An injected fetch implementation is required.");
  }

  const authorization = `Basic ${Buffer.from(`${apiId}:${apiKey}`, "utf8").toString("base64")}`;

  return Object.freeze({
    async resumeRecording(callId, { signal } = {}) {
      const encodedCallId = encodeCallId(callId);
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
      let response;
      try {
        response = await fetch(`${AIRCALL_API_ORIGIN}/v1/calls/${encodedCallId}/resume_recording`, {
          method: "POST",
          headers: { Authorization: authorization },
          redirect: "error",
          signal,
        });
      } catch {
        throw new AircallRecordingClientError("aircall_network_failure", "network_error", true);
      }

      const responseSnapshot = snapshotResponse(response);
      if (!responseSnapshot.ok) {
        const category = responseCategory(responseSnapshot.status);
        throw new AircallRecordingClientError(category.code, category.statusCategory, category.retryable);
      }
    },
  });
}

function snapshotResponse(response) {
  try {
    if (!response) {
      throw new TypeError("Missing response");
    }

    // Read each untrusted response property exactly once before making any
    // classification decision. Do not inspect a response body on this path.
    const ok = response.ok;
    const status = response.status;
    const expectedOk = status >= 200 && status <= 299;
    if (
      typeof ok !== "boolean"
      || !Number.isInteger(status)
      || status < 100
      || status > 599
      || ok !== expectedOk
    ) {
      throw new TypeError("Malformed response");
    }
    return { ok, status };
  } catch {
    // Response objects come from injected fetch implementations and may be
    // proxies or have throwing accessors. Keep their details out of errors.
    throw new AircallRecordingClientError("aircall_network_failure", "network_error", true);
  }
}

function encodeCallId(callId) {
  if (typeof callId !== "string" || !SAFE_OPAQUE_CALL_ID.test(callId) || URL_SCHEME.test(callId) || callId.includes("://")) {
    throw new AircallRecordingClientError("invalid_call_id", "invalid_input", false);
  }
  return encodeURIComponent(callId);
}

function responseCategory(status) {
  if (status === 404 || status === 409 || status === 422) {
    return { code: "aircall_terminal_failure", statusCategory: "terminal", retryable: false };
  }
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return { code: "aircall_server_failure", statusCategory: "server_error", retryable: true };
  }
  return { code: "aircall_client_failure", statusCategory: "client_error", retryable: false };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
