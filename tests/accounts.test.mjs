import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { accountFingerprint, antigravityAccountsPath, readActiveAccountFingerprint } = await import("../lib/accounts.ts");

test("account fingerprint hashes the id and never contains it", () => {
  const fp = accountFingerprint("technomechanicus.it@gmail.com");
  assert.equal(fp.length, 16);
  assert.equal(fp, accountFingerprint("technomechanicus.it@gmail.com"), "fingerprint is stable");
  assert.notEqual(fp, accountFingerprint("someone-else@gmail.com"), "different ids hash differently");
  assert.ok(!fp.includes("gmail.com"), "fingerprint must not leak the account id");
});

test("accounts path can be redirected via environment override", () => {
  const prev = process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  try {
    delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
    assert.match(antigravityAccountsPath(), /antigravity-accounts\.json$/);
    process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = "/tmp/fake-store.json";
    assert.equal(antigravityAccountsPath(), "/tmp/fake-store.json");
  } finally {
    if (prev !== undefined) process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = prev;
    else delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  }
});

test("reads the active account id from a pi-antigravity shaped store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-fallback-accounts-"));
  const storePath = join(dir, "antigravity-accounts.json");
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      activeAccountId: "Technomechanicus.It@gmail.com",
      accounts: {
        "Technomechanicus.It@gmail.com": { type: "oauth", email: "Technomechanicus.It@gmail.com" },
      },
    }),
    "utf8",
  );
  const fp = await readActiveAccountFingerprint(storePath);
  assert.equal(fp, accountFingerprint("technomechanicus.it@gmail.com"), "id is normalized before hashing");
});

test("malformed or missing store keeps detection inert", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-fallback-accounts-"));
  assert.equal(await readActiveAccountFingerprint(join(dir, "does-not-exist.json")), undefined);
  const storePath = join(dir, "antigravity-accounts.json");
  await writeFile(storePath, "not json at all", "utf8");
  assert.equal(await readActiveAccountFingerprint(storePath), undefined);
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: {} }), "utf8");
  assert.equal(await readActiveAccountFingerprint(storePath), undefined);
  await writeFile(storePath, JSON.stringify({ version: 1, activeAccountId: "   ", accounts: {} }), "utf8");
  assert.equal(await readActiveAccountFingerprint(storePath), undefined);
});