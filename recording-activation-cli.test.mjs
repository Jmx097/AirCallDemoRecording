import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./recording-activation-cli.mjs", import.meta.url);
const H = (character) => character.repeat(64);

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

test("CLI keeps PKCS8 private key in an owner-only file and verifies with public SPKI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "recording-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privatePath = join(directory, "approval.pk8.b64");
  const publicPath = join(directory, "approval.spki.b64");
  const scopePath = join(directory, "scope.json");
  const artifactPath = join(directory, "artifact.json");
  const scope = {
    deploymentId: "cli-deploy",
    policyHash: H("a"),
    pilotHash: H("b"),
    consentColumnId: "dropdown_mm5v99w5",
    approverReferenceHash: H("c"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  await writeFile(scopePath, JSON.stringify(scope));

  let result = run(["keygen", "--private", privatePath, "--public", publicPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  assert.equal((await stat(publicPath)).mode & 0o777, 0o644);
  const privateValue = (await readFile(privatePath, "utf8")).trim();
  assert.equal(result.stdout.includes(privateValue), false, "private key material is never printed");

  result = run(["generate", scopePath, "--private-key", privatePath]);
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(result.stdout);
  assert.match(artifact.signature, /^[A-Za-z0-9+/]{86}==$/);
  await writeFile(artifactPath, JSON.stringify(artifact));

  result = run(["verify", artifactPath, scopePath, "--public-key", publicPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
  const publicValue = (await readFile(publicPath, "utf8")).trim();
  result = run(["verify", artifactPath, scopePath], { RECORDING_APPROVAL_PUBLIC_KEY: publicValue });
  assert.equal(result.status, 0, result.stderr);

  await chmod(privatePath, 0o644);
  result = run(["generate", scopePath, "--private-key", privatePath], { RECORDING_APPROVAL_PRIVATE_KEY: privateValue });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner-only/);
});
