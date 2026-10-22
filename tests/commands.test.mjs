import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    return await import(join(homedir(), ".pi", "agent", "npm", "node_modules", "jiti", "lib", "jiti.mjs"));
  }
}
const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url);
const modelFallback = (await jiti.import("../extensions/index.ts")).default;

async function makeTestEnv(initialConfig) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-model-fallback-cmd-test-"));
  await mkdir(join(cwd, ".pi", "model-fallback"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["pi-model-fallback"] }), "utf8");
  const configPath = join(cwd, ".pi", "model-fallback", "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      initialConfig ?? {
        version: 1,
        enabled: true,
        rules: [
          {
            name: "test-rule",
            matchProviders: ["test-provider"],
            fallback: { provider: "fallback-provider", model: "fallback-model" },
          },
        ],
      },
    ),
    "utf8",
  );
  return { cwd, configPath };
}

function createCommandHarness(cwd) {
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  let selectChoice;

  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool() {},
    async setModel() {
      return true;
    },
    async sendUserMessage() {},
  };

  modelFallback(pi);

  const availableModels = [
    { provider: "openai-codex", id: "gpt-6-luna" },
    { provider: "anthropic", id: "claude-3-7-sonnet" },
  ];

  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: "test-provider", id: "model-1" },
    modelRegistry: {
      find: (provider, id) => availableModels.find((m) => m.provider === provider && m.id === id) ?? null,
      getAvailable: () => availableModels,
    },
    ui: {
      notify(msg, type) {
        notifications.push({ msg, type });
      },
      async select(_title, options) {
        if (selectChoice !== undefined) return selectChoice;
        return options[0];
      },
    },
  };

  const start = handlers.get("session_start");
  if (start) {
    start({}, ctx);
  }

  return {
    commands,
    notifications,
    ctx,
    setSelectChoice(c) {
      selectChoice = c;
    },
    async runCommand(name, args = "") {
      const cmd = commands.get(name);
      assert.ok(cmd, `Command ${name} should be registered`);
      await cmd.handler(args, ctx);
    },
    async getCompletions(name, argumentPrefix) {
      const cmd = commands.get(name);
      assert.ok(cmd, `Command ${name} should be registered`);
      return await cmd.getArgumentCompletions(argumentPrefix, ctx);
    },
  };
}

test("model-fallback:on and :off toggle global enabled flag", async () => {
  const { cwd, configPath } = await makeTestEnv();
  const harness = createCommandHarness(cwd);

  await harness.runCommand("model-fallback:off");
  let saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.enabled, false);

  await harness.runCommand("model-fallback:on");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.enabled, true);

  // aliases
  await harness.runCommand("model-fallback:disable");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.enabled, false);

  await harness.runCommand("model-fallback:enable");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.enabled, true);
});

test("model-fallback:timeout on and off toggle timeout fallback", async () => {
  const { cwd, configPath } = await makeTestEnv({
    version: 1,
    enabled: true,
    rules: [
      {
        name: "test-rule",
        matchProviders: ["test-provider"],
        fallback: { provider: "fallback-provider", model: "fallback-model" },
      },
    ],
    timeoutFallback: {
      enabled: false,
      fallback: { provider: "openai-codex", model: "gpt-6-luna" },
    },
  });
  const harness = createCommandHarness(cwd);

  await harness.runCommand("model-fallback:timeout", "on");
  let saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, true);
  assert.deepEqual(saved.timeoutFallback?.fallback, { provider: "openai-codex", model: "gpt-6-luna" });

  await harness.runCommand("model-fallback:timeout", "off");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, false);

  // Dedicated alias commands
  await harness.runCommand("model-fallback:timeout-on");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, true);

  await harness.runCommand("model-fallback:timeout-off");
  saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, false);
});

test("model-fallback:timeout <provider/model> sets specific fallback model", async () => {
  const { cwd, configPath } = await makeTestEnv();
  const harness = createCommandHarness(cwd);

  await harness.runCommand("model-fallback:timeout", "anthropic/claude-3-7-sonnet");
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, true);
  assert.deepEqual(saved.timeoutFallback?.fallback, { provider: "anthropic", model: "claude-3-7-sonnet" });
});

test("model-fallback:timeout interactive select chooses fallback model", async () => {
  const { cwd, configPath } = await makeTestEnv();
  const harness = createCommandHarness(cwd);
  harness.setSelectChoice("openai-codex/gpt-6-luna");

  await harness.runCommand("model-fallback:timeout", "");
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.timeoutFallback?.enabled, true);
  assert.deepEqual(saved.timeoutFallback?.fallback, { provider: "openai-codex", model: "gpt-6-luna" });
});

test("model-fallback:timeout argument autocompletions provide models and on/off", async () => {
  const { cwd } = await makeTestEnv();
  const harness = createCommandHarness(cwd);

  const allCompletions = await harness.getCompletions("model-fallback:timeout", "");
  const values = allCompletions.map((c) => c.value);
  assert.ok(values.includes("on"));
  assert.ok(values.includes("off"));
  assert.ok(values.includes("openai-codex/gpt-6-luna"));
  assert.ok(values.includes("anthropic/claude-3-7-sonnet"));

  const filtered = await harness.getCompletions("model-fallback:timeout", "ant");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].value, "anthropic/claude-3-7-sonnet");
});
