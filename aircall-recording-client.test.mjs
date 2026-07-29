import assert from "node:assert/strict";
import test from "node:test";
import { AircallRecordingClientError, createAircallRecordingClient } from "./aircall-recording-client.mjs";

const API_ID = "test-api-id";
const API_KEY = "test-api-key-not-a-real-secret";

function clientWith(responseOrFetch, calls = []) {
  const fetch = typeof responseOrFetch === "function"
    ? responseOrFetch
    : async (...args) => { calls.push(args); return responseOrFetch; };
  return createAircallRecordingClient({ apiId: API_ID, apiKey: API_KEY, fetch });
}

function response(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => { throw new Error("response body must not be read"); },
    json: () => { throw new Error("response body must not be read"); },
  };
}

function assertClientError(error, expected) {
  assert.ok(error instanceof AircallRecordingClientError);
  assert.deepEqual(
    { code: error.code, statusCategory: error.statusCategory, retryable: error.retryable },
    expected,
  );
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal(error.message.includes(API_ID), false);
}

test("posts only to the encoded per-call resume endpoint with explicit Basic auth", async () => {
  const calls = [];
  const client = clientWith(response(204), calls);

  await client.resumeRecording("call-id:42");

  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, "https://api.aircall.io/v1/calls/call-id%3A42/resume_recording");
  assert.equal(options.method, "POST");
  assert.deepEqual(Object.keys(options.headers), ["Authorization"]);
  assert.match(options.headers.Authorization, /^Basic /);
  assert.equal(Buffer.from(options.headers.Authorization.slice("Basic ".length), "base64").toString("utf8"), `${API_ID}:${API_KEY}`);
});

test("accepts both 204 and 200 success responses without reading response bodies", async () => {
  for (const status of [204, 200]) {
    const calls = [];
    await clientWith(response(status), calls).resumeRecording("valid-call-id");
    assert.equal(calls.length, 1);
  }
});

test("rejects malformed or URL-like call IDs before making any request", async () => {
  for (const callId of [undefined, null, "", "   ", "call id", "/call", "call/id", "call?x=1", "call#fragment", "https://api.aircall.io/v1/calls/1", "HTTP:opaque"]) {
    const calls = [];
    await assert.rejects(
      clientWith(response(204), calls).resumeRecording(callId),
      (error) => {
        assertClientError(error, { code: "invalid_call_id", statusCategory: "invalid_input", retryable: false });
        return true;
      },
    );
    assert.equal(calls.length, 0, `invalid call ID ${String(callId)} made a request`);
  }
});

test("requires explicit non-empty credentials and an injected fetch implementation", () => {
  for (const args of [
    { apiId: "", apiKey: API_KEY, fetch: async () => response(204) },
    { apiId: "  ", apiKey: API_KEY, fetch: async () => response(204) },
    { apiId: API_ID, apiKey: "", fetch: async () => response(204) },
    { apiId: API_ID, apiKey: "\t", fetch: async () => response(204) },
    { apiId: API_ID, apiKey: API_KEY },
  ]) {
    assert.throws(() => createAircallRecordingClient(args), TypeError);
  }
});

test("classifies generic non-terminal 4xx responses as non-retryable client failures without body access or credential leakage", async () => {
  await assert.rejects(
    clientWith(response(401)).resumeRecording("call-1"),
    (error) => {
      assertClientError(error, { code: "aircall_client_failure", statusCategory: "client_error", retryable: false });
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes(API_KEY), false);
      assert.equal(serialized.includes(API_ID), false);
      return true;
    },
  );
});

test("classifies 404, 409, and 422 as terminal, non-retryable failures without body access", async () => {
  for (const status of [404, 409, 422]) {
    await assert.rejects(
      clientWith(response(status)).resumeRecording("call-1"),
      (error) => {
        assertClientError(error, { code: "aircall_terminal_failure", statusCategory: "terminal", retryable: false });
        assert.equal(error.message.includes(String(status)), false);
        return true;
      },
    );
  }
});

test("classifies 5xx responses as potentially transient without implementing retries", async () => {
  let attempts = 0;
  const client = clientWith(async () => { attempts += 1; return response(500); });

  await assert.rejects(client.resumeRecording("call-1"), (error) => {
    assertClientError(error, { code: "aircall_server_failure", statusCategory: "server_error", retryable: true });
    return true;
  });
  assert.equal(attempts, 1);
});

test("converts hostile response accessors and malformed response shapes into redacted retryable network failures", async () => {
  const sentinel = "response-accessor-secret-do-not-leak";
  const hostileResponses = [
    Object.defineProperty({}, "ok", {
      get() { throw new Error(sentinel); },
    }),
    Object.defineProperties({}, {
      ok: { get() { return false; } },
      status: { get() { throw new Error(sentinel); } },
    }),
    new Proxy({}, {
      get(_target, property) {
        if (property === "ok") throw new Error(sentinel);
        return undefined;
      },
    }),
    { ok: true, status: "204" },
  ];

  for (const hostileResponse of hostileResponses) {
    await assert.rejects(
      clientWith(hostileResponse).resumeRecording("call-1"),
      (error) => {
        // Untrusted response inspection is a retryable network_error and
        // deliberately exposes neither accessor errors nor response details.
        assertClientError(error, { code: "aircall_network_failure", statusCategory: "network_error", retryable: true });
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(JSON.stringify(error).includes(sentinel), false);
        return true;
      },
    );
  }
});

test("rejects incoherent ok/status response snapshots as redacted retryable network failures", async () => {
  const sentinel = "incoherent-response-secret-do-not-leak";
  for (const { ok, status } of [
    { ok: true, status: 404 },
    { ok: false, status: 204 },
    { ok: true, status: 0 },
  ]) {
    const incoherentResponse = Object.defineProperties({}, {
      ok: { value: ok },
      status: { value: status },
      text: { get() { throw new Error(sentinel); } },
      json: { get() { throw new Error(sentinel); } },
    });

    await assert.rejects(
      clientWith(incoherentResponse).resumeRecording("call-1"),
      (error) => {
        assertClientError(error, { code: "aircall_network_failure", statusCategory: "network_error", retryable: true });
        assert.equal(error.cause, undefined);
        assert.equal(error.body, undefined);
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(JSON.stringify(error).includes(sentinel), false);
        return true;
      },
    );
  }
});

test("classifies thrown fetch failures as potentially transient and redacts thrown details", async () => {
  const client = clientWith(async () => { throw new Error(`network failed with ${API_KEY}`); });

  await assert.rejects(client.resumeRecording("call-1"), (error) => {
    assertClientError(error, { code: "aircall_network_failure", statusCategory: "network_error", retryable: true });
    return true;
  });
});
