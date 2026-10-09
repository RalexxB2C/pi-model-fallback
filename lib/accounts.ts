import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isRecord, readJsonIfExists } from "./internal.ts";

/** File that pi-antigravity keeps with the stored accounts and the active one. */
export function antigravityAccountsPath(): string {
  // Test/isolation hook: lets callers redirect the store read without stubbing the agent dir.
  const override = process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  if (override && override.trim() !== "") return override;
  return join(getAgentDir(), "antigravity-accounts.json");
}

/**
 * Fingerprint of the active Antigravity account: a sha-256 prefix of the account id
 * (an email), so no account identifier is ever written to model-fallback state.
 * Returns undefined when the store file is absent, malformed, or has no active
 * account; callers treat undefined as "account-change detection inert".
 */
export async function readActiveAccountFingerprint(path: string): Promise<string | undefined> {
  let json: unknown;
  try {
    json = await readJsonIfExists(path);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const id = typeof json.activeAccountId === "string" ? json.activeAccountId.trim().toLowerCase() : "";
  if (id === "") return undefined;
  return accountFingerprint(id);
}

export function accountFingerprint(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 16);
}