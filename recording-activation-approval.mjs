import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";

const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FIELDS = ["version", "deploymentId", "policyHash", "pilotHash", "consentColumnId", "approverReferenceHash", "expiresAt"];

/** Creates an approval artifact in an offline process holding the PKCS8 private key. */
export function generateActivationApproval(scope, privateKey) {
  const payload = normalize(scope);
  const key = decodeEd25519Key(privateKey, "private");
  const signature = ed25519Sign(null, Buffer.from(canonical(payload)), key).toString("base64");
  return Object.freeze({ ...payload, signature });
}

/** Validates the Ed25519 signature, expiry, and exact deployment/policy/pilot/consent scope. */
export function verifyActivationApproval(artifact, expected, publicKey, now = new Date()) {
  try {
    const payload = normalize(artifact);
    let signature;
    try { signature = decodeCanonicalBase64(artifact?.signature, "invalid_signature"); }
    catch { return denied("invalid_signature"); }
    if (signature.length !== 64) return denied("invalid_signature");
    const key = decodeEd25519Key(publicKey, "public");
    if (!ed25519Verify(null, Buffer.from(canonical(payload)), key, signature)) return denied("invalid_signature");
    const expectedPayload = normalize({ ...expected, version: 1, approverReferenceHash: payload.approverReferenceHash, expiresAt: payload.expiresAt });
    for (const field of ["deploymentId", "policyHash", "pilotHash", "consentColumnId"])
      if (payload[field] !== expectedPayload[field]) return denied("scope_mismatch");
    const instant = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(instant) || Date.parse(payload.expiresAt) <= instant) return denied("expired");
    return Object.freeze({ valid: true, payload, artifactDigest: sha256(`${canonical(payload)}.${artifact.signature}`) });
  } catch {
    return denied("invalid_artifact");
  }
}

export function validateActivationApprovalPublicKey(publicKey) {
  decodeEd25519Key(publicKey, "public");
  return publicKey;
}

export function hashActivationValue(domain, value) {
  if (typeof domain !== "string" || typeof value !== "string") throw new TypeError("invalid_hash_input");
  return sha256(`${domain}\0${value}`);
}

export function hashPilotScope(userIds, numberIds) {
  const canonicalIds = (values) => [...values].map(String).sort().join(",");
  return hashActivationValue("pilot-v1", `users=${canonicalIds(userIds)};numbers=${canonicalIds(numberIds)}`);
}

function normalize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_artifact");
  const out = {
    version: value.version ?? 1,
    deploymentId: value.deploymentId,
    policyHash: value.policyHash,
    pilotHash: value.pilotHash,
    consentColumnId: value.consentColumnId,
    approverReferenceHash: value.approverReferenceHash,
    expiresAt: value.expiresAt,
  };
  if (out.version !== 1 || !ID.test(out.deploymentId ?? "") || !HEX.test(out.policyHash ?? "") || !HEX.test(out.pilotHash ?? "")
    || !ID.test(out.consentColumnId ?? "") || !HEX.test(out.approverReferenceHash ?? "") || typeof out.expiresAt !== "string" || !Number.isFinite(Date.parse(out.expiresAt)))
    throw new TypeError("invalid_artifact");
  return Object.freeze(out);
}

function canonical(payload) {
  return JSON.stringify(Object.fromEntries(FIELDS.map((key) => [key, payload[key]])));
}

function decodeEd25519Key(value, kind) {
  const bytes = decodeCanonicalBase64(value, "invalid_approval_key");
  let key;
  try {
    key = kind === "private"
      ? createPrivateKey({ key: bytes, format: "der", type: "pkcs8" })
      : createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    throw new TypeError("invalid_approval_key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("invalid_approval_key");
  const exported = key.export({ format: "der", type: kind === "private" ? "pkcs8" : "spki" });
  if (!Buffer.from(exported).equals(bytes)) throw new TypeError("invalid_approval_key");
  return key;
}

function decodeCanonicalBase64(value, reason) {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value)) throw new TypeError(reason);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new TypeError(reason);
  return bytes;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function denied(reason) { return Object.freeze({ valid: false, reason }); }
