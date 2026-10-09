import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The extension imports TS files via ".js" specifiers, which pi resolves through jiti.
// jiti is a transitive dependency of the pi installation rather than of this repo.
async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    const { homedir } = await import("node:os");
    return await import(join(homedir(), ".pi", "agent", "npm", "node_modules", "jiti", "lib", "jiti.mjs"));
  }
}
const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("../extensions/index.ts");
const { cooldownMsFor } = mod;
const modelFallback = mod.default;

const SOURCE = { provider: "antigravity", model: "gemini-3.8-flash" };
const FALLBACK = { provider: "antigravity", model: "claude-opus-4-6" };
const SOURCE_KEY = `${SOURCE.provider}/${SOURCE.model}`;
const FALLBACK_KEY = `${FALLBACK.provider}/${FALLBACK.model}`;

test("configured rule cooldown is a hard cap over retry-after and reset headers", () => {
  const cap = 300000;
  const headers = { "retry-after": "3600" };
  assert.equal(cooldownMsFor(cap, 429, headers), cap, "long server header must not stretch past the rule cap");
  assert.equal(cooldownMsFor(cap, 429, { "x-ratelimit-reset": "172800" }), cap);
  assert.equal(cooldownMsFor(cap, 503, {}), cap);
  // A shorter server header may shorten the cooldown below the cap.
  assert.equal(cooldownMsFor(cap, 429, { "retry-after": "120" }), 120000);
  // Without a rule cap the header still wins.
  assert.equal(cooldownMsFor(undefined, 429, { "retry-after": "3600" }), 3600000);
  assert.equal(cooldownMsFor(undefined, 429, {}), 72 * 60 * 60 * 1000);
  assert.equal(cooldownMsFor(undefined, 503, {}), 10 * 60 * 1000);
});

async function writeStore(path, activeAccountId) {
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      activeAccountId,
      accounts: { [activeAccountId]: { type: "oauth", email: activeAccountId } },
    }),
    "utf8",
  );
}

async function makeProject({ rules, resetOnAccountChange, state: seedState } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-model-fallback-cap-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["pi-model-fallback"] }), "utf8");
  const configPath = join(cwd, ".pi", "model-fallback", "config.json");
  const statePath = join(cwd, ".pi", "model-fallback", "state.json");
  await mkdir(join(cwd, ".pi", "model-fallback"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      enabled: true,
      autoRetry: false,
      resetOnAccountChange,
      rules: rules ?? [
        {
          name: "gemini-to-opus",
          matchModels: [{ provider: SOURCE.provider, model: SOURCE.model }],
          statuses: [429],
          cooldownMs: 300000,
          fallback: FALLBACK,
        },
      ],
    }),
    "utf8",
  );
  if (seedState) await writeFile(statePath, JSON.stringify(seedState), "utf8");
  return { cwd, configPath, statePath };
}

function createHarness(project) {
  const handlers = new Map();
  const calls = { setModel: [], notifications: [] };
  const pi = {
    on(type, handler) {
      handlers.set(type, handler);
    },
    registerCommand() {},
    registerTool() {},
    async setModel(model) {
      calls.setModel.push({ provider: model.provider, id: model.id });
      harness.ctx.model = { provider: model.provider, id: model.id };
      return true;
    },
    async sendUserMessage() {},
  };
  modelFallback(pi);
  const harness = {
    pi,
    handlers,
    calls,
    ctx: {
      cwd: project.cwd,
      hasUI: true,
      model: { provider: SOURCE.provider, id: SOURCE.model },
      modelRegistry: {
        find: (provider, id) => ({ provider, id }),
      },
      ui: {
        notify: (message, level) => calls.notifications.push({ message, level }),
        setStatus() {},
        confirm: async () => true,
      },
      sessionManager: { getEntries: () => [] },
    },
  };
  return harness;
}

async function seedActiveState(project) {
  // Fresh quota wall: gemini is cooling down until far in the future, current account owns it.
  await writeFile(
    project.statePath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          source: SOURCE,
          fallback: FALLBACK,
          status: 429,
          ruleName: "gemini-to-opus",
          createdAt: new Date().toISOString(),
          until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      ],
    }),
    "utf8",
  );
}

test("account change clears cooldown state and restores the original model", async () => {
  const project = await makeProject({ resetOnAccountChange: true });
  await seedActiveState(project);
  const firstAccount = "user-a@example.com";
  const secondAccount = "user-b@example.com";
  const accountsPath = join(project.cwd, ".pi", "antigravity-accounts.json");
  await writeStore(accountsPath, firstAccount);
  process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = accountsPath;
  try {
    const { accountFingerprint } = await import("../lib/accounts.ts");
    const harness = createHarness(project);

    // First start: the pinned cooldown of the previous account applies (switch to opus)...
    await harness.handlers.get("agent_start")(undefined, harness.ctx);
    assert.deepEqual(harness.calls.setModel, [{ provider: FALLBACK.provider, id: FALLBACK.model }]);
    let state = JSON.parse(await readFile(project.statePath, "utf8"));
    assert.equal(state.accountFingerprint, accountFingerprint(firstAccount), "first run stores the current account fingerprint");
    assert.ok(state.accountFingerprint, "first run stores the current account fingerprint");
    assert.equal(state.entries.length, 1);

    // ...the user then switches accounts in pi-antigravity.
    await writeStore(accountsPath, secondAccount);
    harness.calls.setModel.length = 0;
    await harness.handlers.get("agent_start")(undefined, harness.ctx);

    // The stale cooldown must be gone: the fresh account should run Gemini again, not stay
    // pinned on Opus for an hour.
    assert.deepEqual(
      harness.calls.setModel,
      [{ provider: SOURCE.provider, id: SOURCE.model }],
      "account change must return to the original model",
    );
    state = JSON.parse(await readFile(project.statePath, "utf8"));
    assert.equal(state.entries.length, 0, "stale cooldown entries are cleared");
    assert.equal(harness.calls.sendUserMessage?.length ?? 0, 0, "no prompt replay");
  } finally {
    delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  }
});

test("resetOnAccountChange: false keeps cooldown state across account switches", async () => {
  const project = await makeProject({ resetOnAccountChange: false });
  await seedActiveState(project);
  const accountsPath = join(project.cwd, ".pi", "antigravity-accounts.json");
  await writeStore(accountsPath, "user-a@example.com");
  process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = accountsPath;
  try {
    const harness = createHarness(project);
    await harness.handlers.get("agent_start")(undefined, harness.ctx);
    await writeStore(accountsPath, "user-b@example.com");
    await harness.handlers.get("agent_start")(undefined, harness.ctx);

    // Only the initial persistent-fallback switch happened; no re-restore on "change".
    assert.deepEqual(harness.calls.setModel, [{ provider: FALLBACK.provider, id: FALLBACK.model }]);
    const state = JSON.parse(await readFile(project.statePath, "utf8"));
    assert.equal(state.entries.length, 1, "cooldown entry survives when opt-out is set");
    assert.equal(state.accountFingerprint, undefined);
  } finally {
    delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  }
});

test("returns to the original model on a successful response once its cooldown expired", async () => {
  const project = await makeProject({ resetOnAccountChange: true });
  const accountsPath = join(project.cwd, ".pi", "antigravity-accounts.json");
  await writeStore(accountsPath, "user-a@example.com");
  process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = accountsPath;
  try {
    const { accountFingerprint } = await import("../lib/accounts.ts");
    // Cooldown still active at pin time, expiring shortly afterwards so the same session
    // (still pinned on Opus) crosses the expiry before the next response arrives.
    await writeFile(
      project.statePath,
      JSON.stringify({
        version: 1,
        accountFingerprint: accountFingerprint("user-a@example.com"),
        entries: [
          {
            source: SOURCE,
            fallback: FALLBACK,
            status: 429,
            ruleName: "gemini-to-opus",
            createdAt: new Date(Date.now() - 1000).toISOString(),
            until: new Date(Date.now() + 300).toISOString(),
          },
        ],
      }),
      "utf8",
    );
    const harness = createHarness(project);
    await harness.handlers.get("agent_start")(undefined, harness.ctx);
    assert.deepEqual(
      harness.calls.setModel,
      [{ provider: FALLBACK.provider, id: FALLBACK.model }],
      "the session is pinned on the fallback while the cooldown is active",
    );
    harness.calls.setModel.length = 0;

    await new Promise((resolve) => setTimeout(resolve, 400));
    // A healthy response after the cooldown expired lifts the pin and goes back to Gemini.
    await harness.handlers.get("after_provider_response")({ status: 200, headers: {} }, harness.ctx);

    const last = harness.calls.setModel.at(-1);
    assert.deepEqual(
      last,
      { provider: SOURCE.provider, id: SOURCE.model },
      "cooldown expiry must lift the pin and go back to the original model",
    );

    // A fresh session must not re-pin from the now-expired entry.
    const freshHarness = createHarness(project);
    await freshHarness.handlers.get("agent_start")(undefined, freshHarness.ctx);
    assert.deepEqual(freshHarness.calls.setModel, [], "expired entry must not re-pin a fresh session");
  } finally {
    delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  }
});

test("429 with a long retry-after header is capped by the rule cooldownMs", async () => {
  const project = await makeProject({ resetOnAccountChange: true });
  const accountsPath = join(project.cwd, ".pi", "antigravity-accounts.json");
  await writeStore(accountsPath, "user-a@example.com");
  process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH = accountsPath;
  try {
    const { accountFingerprint } = await import("../lib/accounts.ts");
    await writeFile(
      project.statePath,
      JSON.stringify({ version: 1, accountFingerprint: accountFingerprint("user-a@example.com"), entries: [] }),
      "utf8",
    );
    const harness = createHarness(project);
    await harness.handlers.get("agent_start")(undefined, harness.ctx);

    await harness.handlers.get("after_provider_response")(
      { status: 429, headers: { "retry-after": "3600" } },
      harness.ctx,
    );

    const state = JSON.parse(await readFile(project.statePath, "utf8"));
    assert.equal(state.entries.length, 1);
    const entry = state.entries[0];
    const spanMs = Date.parse(entry.until) - Date.parse(entry.createdAt);
    assert.equal(spanMs, 300000, "rule cooldownMs must cap the header-derived window");
    assert.deepEqual(entry.fallback, FALLBACK);
  } finally {
    delete process.env.PI_MODEL_FALLBACK_ACCOUNTS_PATH;
  }
});