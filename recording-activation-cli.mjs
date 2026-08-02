#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { chmod, open, unlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { generateActivationApproval, verifyActivationApproval } from "./recording-activation-approval.mjs";

const USAGE = `usage:
  recording-activation-cli.mjs keygen --private PRIVATE_KEY_FILE --public PUBLIC_KEY_FILE
  recording-activation-cli.mjs generate SCOPE_JSON --private-key PRIVATE_KEY_FILE
  recording-activation-cli.mjs verify ARTIFACT_JSON EXPECTED_SCOPE_JSON [--public-key PUBLIC_KEY_FILE]

Key files contain canonical base64 DER (private PKCS8; public SPKI). Verify may use
RECORDING_APPROVAL_PUBLIC_KEY instead of --public-key.`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keygen") return keygen(parseOptions(args, [], ["private", "public"]));
  if (command === "generate") {
    const options = parseOptions(args, ["scope"], ["private-key"]);
    const scope = await readJson(options.scope);
    const privateKey = await readPrivateKey(options["private-key"]);
    process.stdout.write(`${JSON.stringify(generateActivationApproval(scope, privateKey), null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const options = parseOptions(args, ["artifact", "expected"], [] , ["public-key"]);
    const publicKey = options["public-key"]
      ? await readPublicKey(options["public-key"])
      : process.env.RECORDING_APPROVAL_PUBLIC_KEY;
    if (!publicKey) throw new Error("--public-key or RECORDING_APPROVAL_PUBLIC_KEY is required");
    const result = verifyActivationApproval(await readJson(options.artifact), await readJson(options.expected), publicKey);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  throw new Error(USAGE);
}

function parseOptions(args, positionalNames, requiredOptions, optionalOptions = []) {
  const out = {};
  let position = 0;
  const allowed = new Set([...requiredOptions, ...optionalOptions]);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value.startsWith("--")) {
      if (position >= positionalNames.length) throw new Error(USAGE);
      out[positionalNames[position++]] = value;
      continue;
    }
    const name = value.slice(2);
    if (!allowed.has(name) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(USAGE);
    out[name] = args[++i];
  }
  if (position !== positionalNames.length || requiredOptions.some((name) => !out[name])) throw new Error(USAGE);
  return out;
}

async function keygen(options) {
  if (options.private === options.public) throw new Error("private and public output paths must differ");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateText = `${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}\n`;
  const publicText = `${publicKey.export({ format: "der", type: "spki" }).toString("base64")}\n`;
  let privateCreated = false;
  let publicCreated = false;
  try {
    await writeFile(options.private, privateText, { flag: "wx", mode: 0o600 });
    privateCreated = true;
    await chmod(options.private, 0o600);
    await writeFile(options.public, publicText, { flag: "wx", mode: 0o644 });
    publicCreated = true;
    await chmod(options.public, 0o644);
  } catch (error) {
    if (publicCreated) await unlink(options.public).catch(() => {});
    if (privateCreated) await unlink(options.private).catch(() => {});
    throw error;
  }
  process.stdout.write(`public key written to ${options.public}\nprivate key written to ${options.private}\n`);
}

async function readPrivateKey(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
      throw new Error("private key file must be owner-only and owned by the current user");
    return cleanKeyFile(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function readPublicKey(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("public key path must be a regular file");
    return cleanKeyFile(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function readJson(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(await handle.readFile("utf8")); }
  finally { await handle.close(); }
}
function cleanKeyFile(value) {
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) throw new Error("key file must contain one canonical base64 line");
  return value.slice(0, -1);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
