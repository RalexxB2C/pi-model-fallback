import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  analyzeRuleWarnings,
  defaultConfig,
  findFallback,
  modelKey,
  modelRefKey,
  validateConfigShape,
  type ModelFallbackConfig,
  type ModelRef,
  type RuleWarning,
} from "../lib/config.js";
import { parseReasonFromErrorMessage, parseStatusFromErrorMessage } from "../lib/error-status.js";
import { antigravityAccountsPath, readActiveAccountFingerprint } from "../lib/accounts.ts";
import { emptyState, findActiveStateEntry, pruneExpiredState, readState, upsertStateEntry, validateStateShape, writeState, type FallbackState } from "../lib/state.js";
import { isRecord } from "../lib/internal.ts";
import { modelFallbackPaths, readConfig, writeConfig, type ModelFallbackPaths } from "../lib/storage.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_KEY = "model-fallback";
const DEFAULT_429_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const DEFAULT_5XX_COOLDOWN_MS = 10 * 60 * 1000;
// pi-antigravity keeps a multi-account store; a hard quota wall makes it silently switch
// accounts mid-request, so cooldown state recorded for one account must never pin another.
const ACCOUNT_CHANGE_PROVIDER = "antigravity";

export default function modelFallback(pi: ExtensionAPI) {
  let paths: ModelFallbackPaths = modelFallbackPaths(getAgentDir());
  let pathsResolvedForCwd: string | undefined;
  let config: ModelFallbackConfig | undefined;
  let state: FallbackState | undefined;
  let originalModelKey: string | undefined;
  let activeFallbackKey: string | undefined;
  let lastFallbackReason: string | undefined;
  let lastContext: ExtensionContext | undefined;
  // Models already fallen back to during this run (plus the original). A cascade may only
  // target a model never visited, which makes chains (free → kimi → glm) safe while
  // preventing A→B→A ping-pong with circular rules.
  let visitedFallbackKeys = new Set<string>();

  function syncPaths(ctx: ExtensionContext): void {
    if (pathsResolvedForCwd === ctx.cwd) return;
    pathsResolvedForCwd = ctx.cwd;
    paths = shouldUseProjectLocalState(ctx) ? modelFallbackPaths(join(ctx.cwd, ".pi")) : modelFallbackPaths(getAgentDir());
  }

  async function loadConfig(ctx: ExtensionContext): Promise<ModelFallbackConfig | undefined> {
    try {
      syncPaths(ctx);
      config = await readConfig(paths.config);
      return config;
    } catch (error) {
      ctx.ui.notify(`Model fallback config error: ${errorMessage(error)}`, "warning");
      return undefined;
    }
  }

  async function loadState(ctx: ExtensionContext): Promise<FallbackState | undefined> {
    try {
      syncPaths(ctx);
      const statePath = paths.state;
      if (!existsSync(statePath)) {
        state = emptyState();
        return state;
      }

      const before = validateStateShape(JSON.parse(await readFile(statePath, "utf8")));
      const after = pruneExpiredState(before);
      state = after;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await writeState(statePath, after);
      }
      return state;
    } catch (error) {
      ctx.ui.notify(`Model fallback state error: ${errorMessage(error)}`, "warning");
      return undefined;
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, activeFallbackKey ? `fallback:${activeFallbackKey}` : undefined);
  }

  async function applyPersistentFallback(ctx: ExtensionContext): Promise<void> {
    const current = ctx.model;
    if (!current) return;
    const loadedConfig = config ?? (await loadConfig(ctx));
    if (!loadedConfig?.enabled) return;
    const loadedState = state ?? (await loadState(ctx));
    if (!loadedState) return;

    const active = findActiveStateEntry(loadedState, modelToRef(current));
    if (!active) return;

    const fallbackModel = ctx.modelRegistry.find(active.fallback.provider, active.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback state target missing: ${modelRefKey(active.fallback)}`, "warning");
      return;
    }

    originalModelKey = modelKey(current);
    activeFallbackKey = modelRefKey(active.fallback);
    visitedFallbackKeys = new Set([originalModelKey, activeFallbackKey]);
    lastFallbackReason = `persistent ${active.status} from ${originalModelKey} until ${active.until}`;
    updateStatus(ctx);
    const ok = await pi.setModel(fallbackModel);
    if (!ok) {
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(active.fallback)}`, "warning");
      originalModelKey = undefined;
      activeFallbackKey = undefined;
      lastFallbackReason = undefined;
      visitedFallbackKeys = new Set();
      updateStatus(ctx);
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify(`Model fallback preselected: ${originalModelKey} → ${activeFallbackKey} until ${active.until}.`, "warning");
  }

  async function persistFailure(source: ModelRef, status: number, headers: Record<string, string>, ctx: ExtensionContext, reason?: string): Promise<boolean> {
    const loaded = config ?? (await loadConfig(ctx));
    if (!loaded) return false;
    const match = findFallback(loaded, { provider: source.provider, id: source.model }, status, reason);
    if (!match) return false;

    const fallbackModel = ctx.modelRegistry.find(match.fallback.provider, match.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback missing: ${modelRefKey(match.fallback)}`, "warning");
      return false;
    }

    // Loop guard: never fall back to a model already visited this run (the original or an
    // earlier fallback). This both blocks circular rules from ping-ponging and stops the
    // current fallback from re-selecting itself, while still allowing onward cascades
    // (free → kimi → glm) when a different rule matches the fallback's own failure.
    // Exception: when the failing model is the remembered original and the candidate is the
    // already-preselected fallback, re-applying the same hop is idempotent and stays allowed
    // (turn attribution can lag behind the preselection).
    const fallbackKey = modelRefKey(match.fallback);
    const sourceKey = modelRefKey(source);
    const idempotentReapply = fallbackKey === activeFallbackKey && sourceKey === originalModelKey;
    if (visitedFallbackKeys.has(fallbackKey) && !idempotentReapply) return false;

    const now = new Date();
    const until = new Date(now.getTime() + cooldownMsFor(match.rule.cooldownMs, status, headers)).toISOString();
    const loadedState = state ?? (await loadState(ctx)) ?? { version: 1 as const, entries: [] };
    state = upsertStateEntry(loadedState, {
      source,
      fallback: match.fallback,
      status,
      until,
      createdAt: now.toISOString(),
      ruleName: match.rule.name,
    });
    await writeState(paths.state, state);

    const prevOriginal = originalModelKey;
    const prevActive = activeFallbackKey;
    const prevReason = lastFallbackReason;
    const prevVisited = visitedFallbackKeys;
    // Mark before setModel so the model_select handler keeps fallback bookkeeping.
    if (!originalModelKey) originalModelKey = sourceKey;
    activeFallbackKey = fallbackKey;
    visitedFallbackKeys = new Set(prevVisited);
    visitedFallbackKeys.add(sourceKey);
    visitedFallbackKeys.add(fallbackKey);
    lastFallbackReason = `${status} from ${sourceKey}${reason ? ` (${reason})` : ""}; persistent until ${until}`;
    updateStatus(ctx);

    const ok = await pi.setModel(fallbackModel);
    if (!ok) {
      originalModelKey = prevOriginal;
      activeFallbackKey = prevActive;
      lastFallbackReason = prevReason;
      visitedFallbackKeys = prevVisited;
      updateStatus(ctx);
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(match.fallback)}`, "warning");
      return false;
    }
    ctx.ui.notify(`Model fallback: ${originalModelKey} → ${activeFallbackKey} (${status}). Future sessions preselect fallback until ${until}.`, "warning");
    return true;
  }

  /**
   * Track the active Antigravity account fingerprint in persistent state. When the
   * fingerprint changes, stale cooldown entries from the previous account are cleared and
   * the original model is restored: a freshly switched account may still have quota, so
   * it must not stay pinned on the fallback model. Missing or malformed accounts store
   * keeps detection inert.
   */
  async function refreshAccountState(ctx: ExtensionContext, provider: string): Promise<void> {
    const loadedConfig = config ?? (await loadConfig(ctx));
    if (!loadedConfig || loadedConfig.resetOnAccountChange === false) return;
    if (provider !== ACCOUNT_CHANGE_PROVIDER) return;
    const fingerprint = await readActiveAccountFingerprint(antigravityAccountsPath());
    if (!fingerprint) return;
    syncPaths(ctx);
    const loadedState = state ?? (await loadState(ctx));
    if (!loadedState) return;
    const stored = loadedState.accountFingerprint;
    if (stored === fingerprint) return;
    const changed = stored !== undefined;
    state = { version: 1, entries: changed ? [] : [...loadedState.entries], accountFingerprint: fingerprint };
    await writeState(paths.state, state);
    if (!changed) return;
    ctx.ui.notify("Model fallback: Antigravity account changed; cooldown state reset.", "info");
    await restoreOriginalModel(ctx, "account change");
  }

  /** Return to the remembered original model without replaying any prompt. */
  async function restoreOriginalModel(ctx: ExtensionContext, reason: string): Promise<void> {
    const target = originalModelKey;
    activeFallbackKey = undefined;
    originalModelKey = undefined;
    lastFallbackReason = undefined;
    visitedFallbackKeys = new Set();
    updateStatus(ctx);
    if (!target) return;
    const [provider, ...modelParts] = target.split("/");
    const model = ctx.modelRegistry.find(provider, modelParts.join("/"));
    if (!model) {
      ctx.ui.notify(`Model fallback original missing: ${target}`, "warning");
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`Model fallback original auth unavailable: ${target}`, "warning");
      return;
    }
    ctx.ui.notify(`Model fallback: returned to ${target} (${reason}).`, "info");
  }

  /** Restore the remembered original model once its cooldown entry has expired. */
  async function restoreAfterCooldownExpiry(ctx: ExtensionContext): Promise<void> {
    if (!activeFallbackKey || !originalModelKey) return;
    syncPaths(ctx);
    const loadedState = state ?? (await loadState(ctx));
    if (!loadedState) return;
    const [provider, ...modelParts] = originalModelKey.split("/");
    const sourceRef = { provider, model: modelParts.join("/") };
    const active = findActiveStateEntry(loadedState, sourceRef);
    if (active && modelRefKey(active.fallback) === activeFallbackKey) return;
    await restoreOriginalModel(ctx, `cooldown for ${originalModelKey} expired`);
  }

  pi.on("agent_start", async (_event, ctx) => {
    lastContext = ctx;
    await loadConfig(ctx);
    await loadState(ctx);
    visitedFallbackKeys = new Set();
    if (ctx.model) await refreshAccountState(ctx, ctx.model.provider);
    await applyPersistentFallback(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (activeFallbackKey && modelKey(event.model) !== activeFallbackKey) {
      activeFallbackKey = undefined;
      originalModelKey = undefined;
      lastFallbackReason = undefined;
      visitedFallbackKeys = new Set();
      updateStatus(ctx);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const current = ctx.model;
    const loaded = config ?? (await loadConfig(ctx));
    if (!current || !loaded) return;
    await refreshAccountState(ctx, current.provider);
    if (event.status >= 200 && event.status < 300) {
      await restoreAfterCooldownExpiry(ctx);
      return;
    }

    await persistFailure(modelToRef(current), event.status, event.headers, ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as unknown;
    if (!isRecord(message) || message.role !== "assistant") return;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (!errorMessage) return;
    if (ctx.model) await refreshAccountState(ctx, ctx.model.provider);
    const status = parseStatusFromErrorMessage(errorMessage);
    if (status === undefined) return;
    const reason = parseReasonFromErrorMessage(errorMessage);
    const provider = typeof message.provider === "string" ? message.provider : ctx.model?.provider;
    const model = typeof message.model === "string" ? message.model : ctx.model?.id;
    if (!provider || !model) return;
    const switched = await persistFailure({ provider, model }, status, {}, ctx, reason);
    if (!switched) return;
    const loaded = config;
    if (!loaded || loaded.autoRetry === false) return;
    const prompt = lastUserPromptText(ctx);
    if (!prompt) return;
    ctx.ui.notify(`Model fallback: retrying failed prompt on ${activeFallbackKey}.`, "info");
    await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  });

  async function setEnabled(nextEnabled: boolean, cmdCtx: ExtensionCommandContext): Promise<void> {
    lastContext = cmdCtx;
    const loaded = config ?? (await loadConfig(cmdCtx)) ?? defaultConfig();
    loaded.enabled = nextEnabled;
    syncPaths(cmdCtx);
    await writeConfig(paths.config, loaded);
    config = loaded;
    cmdCtx.ui.notify(`Model fallback ${nextEnabled ? "enabled" : "disabled"}.`, "info");
  }

  pi.registerCommand("model-fallback:status", {
    description: "Show model fallback status",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      const loaded = config ?? (await loadConfig(ctx)) ?? defaultConfig();
      const loadedState = state ?? (await loadState(ctx)) ?? { version: 1 as const, entries: [] };
      ctx.ui.notify(formatStatus(loaded, loadedState, paths.config, paths.state, analyzeRuleWarnings(loaded), activeFallbackKey, originalModelKey, lastFallbackReason), "info");
    },
  });

  pi.registerCommand("model-fallback:on", {
    description: "Enable model fallback globally",
    handler: (_args, ctx) => setEnabled(true, ctx),
  });

  pi.registerCommand("model-fallback:off", {
    description: "Disable model fallback globally",
    handler: (_args, ctx) => setEnabled(false, ctx),
  });

  pi.registerCommand("model-fallback:enable", {
    description: "Enable model fallback globally (alias for :on)",
    handler: (_args, ctx) => setEnabled(true, ctx),
  });

  pi.registerCommand("model-fallback:disable", {
    description: "Disable model fallback globally (alias for :off)",
    handler: (_args, ctx) => setEnabled(false, ctx),
  });

  async function applyTimeoutFallback(target: ModelRef, targetCtx: ExtensionContext, loaded: ModelFallbackConfig): Promise<void> {
    loaded.timeoutFallback = {
      enabled: true,
      fallback: target,
      cooldownMs: loaded.timeoutFallback?.cooldownMs ?? 300000,
    };
    syncPaths(targetCtx);
    await writeConfig(paths.config, loaded);
    config = loaded;
    targetCtx.ui.notify(`Model fallback for timeouts set to ${modelRefKey(target)} (enabled).`, "info");
  }

  async function handleTimeoutCommand(args: string, cmdCtx: ExtensionCommandContext): Promise<void> {
    const loaded = config ?? (await loadConfig(cmdCtx)) ?? defaultConfig();
    const trimmed = args.trim();

    if (trimmed === "on") {
      if (!loaded.timeoutFallback) {
        const existingRule = loaded.rules.find((r) => r.reasons?.includes("response_headers_timeout"));
        if (existingRule) {
          await applyTimeoutFallback(existingRule.fallback, cmdCtx, loaded);
        } else {
          if (cmdCtx.hasUI && typeof cmdCtx.ui.select === "function") {
            return await promptAndSetTimeoutModel(cmdCtx, loaded);
          }
          cmdCtx.ui.notify("No fallback model configured for timeouts. Usage: /model-fallback:timeout <provider/model>", "warning");
        }
      } else {
        loaded.timeoutFallback.enabled = true;
        syncPaths(cmdCtx);
        await writeConfig(paths.config, loaded);
        config = loaded;
        cmdCtx.ui.notify(`Model fallback for timeouts enabled (${modelRefKey(loaded.timeoutFallback.fallback)}).`, "info");
      }
      return;
    }

    if (trimmed === "off") {
      const existingFallback = loaded.timeoutFallback?.fallback
        ?? loaded.rules.find((r) => r.reasons?.includes("response_headers_timeout"))?.fallback
        ?? loaded.rules[0]?.fallback;
      if (!existingFallback) {
        cmdCtx.ui.notify("No fallback rule configured to disable.", "warning");
        return;
      }
      loaded.timeoutFallback = {
        enabled: false,
        fallback: existingFallback,
        cooldownMs: loaded.timeoutFallback?.cooldownMs ?? 300000,
      };
      syncPaths(cmdCtx);
      await writeConfig(paths.config, loaded);
      config = loaded;
      cmdCtx.ui.notify("Model fallback for timeouts disabled.", "info");
      return;
    }

    if (trimmed.length > 0) {
      const parsed = parseModelInput(trimmed);
      if (!parsed) {
        cmdCtx.ui.notify(`Invalid model format: "${trimmed}". Expected "provider/model" (e.g. "openai-codex/gpt-6-luna").`, "warning");
        return;
      }
      const found = cmdCtx.modelRegistry.find(parsed.provider, parsed.model);
      if (!found) {
        cmdCtx.ui.notify(`Model not found in registry: ${modelRefKey(parsed)}. Check available models.`, "warning");
        return;
      }
      await applyTimeoutFallback(parsed, cmdCtx, loaded);
      return;
    }

    if (cmdCtx.hasUI && typeof cmdCtx.ui.select === "function") {
      return await promptAndSetTimeoutModel(cmdCtx, loaded);
    }
    cmdCtx.ui.notify(`Timeout fallback: ${formatTimeoutStatus(loaded)}. Usage: /model-fallback:timeout <provider/model> | on | off`, "info");
  }

  async function promptAndSetTimeoutModel(dialogCtx: ExtensionContext, loaded: ModelFallbackConfig): Promise<void> {
    const available = getAvailableModels(dialogCtx);
    if (available.length === 0) {
      dialogCtx.ui.notify("No available models found in registry. Specify model manually: /model-fallback:timeout <provider/model>", "warning");
      return;
    }
    const currentKey = loaded.timeoutFallback ? modelRefKey(loaded.timeoutFallback.fallback) : undefined;
    const options = available.map((m) => {
      const key = `${m.provider}/${m.id}`;
      return key === currentKey ? `${key} (current)` : key;
    });
    const selected = await dialogCtx.ui.select("Select fallback model for timeout errors:", options);
    if (!selected) return;
    const cleanKey = selected.replace(/\s+\(current\)$/, "").trim();
    const parsed = parseModelInput(cleanKey);
    if (!parsed) return;
    await applyTimeoutFallback(parsed, dialogCtx, loaded);
  }

  pi.registerCommand("model-fallback:timeout", {
    description: "Configure or toggle fallback for timeout errors",
    getArgumentCompletions: (argumentPrefix: string, cmdCtx?: ExtensionCommandContext) => {
      const prefix = argumentPrefix.toLowerCase().trim();
      const items: AutocompleteItem[] = [
        { value: "on", label: "on", description: "Enable timeout fallback" },
        { value: "off", label: "off", description: "Disable timeout fallback" },
      ];
      const activeCtx = cmdCtx ?? lastContext;
      if (activeCtx) {
        const models = getAvailableModels(activeCtx);
        for (const m of models) {
          const key = `${m.provider}/${m.id}`;
          items.push({ value: key, label: key, description: `Set timeout fallback to ${key}` });
        }
      }
      return items.filter((item) => item.value.toLowerCase().startsWith(prefix));
    },
    handler: async (args, ctx) => {
      lastContext = ctx;
      await handleTimeoutCommand(args, ctx);
    },
  });

  pi.registerCommand("model-fallback:timeout-on", {
    description: "Enable fallback for timeout errors",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      await handleTimeoutCommand("on", ctx);
    },
  });

  pi.registerCommand("model-fallback:timeout-off", {
    description: "Disable fallback for timeout errors",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      await handleTimeoutCommand("off", ctx);
    },
  });

  pi.registerCommand("model-fallback:reset", {
    description: "Return from fallback model to the pre-fallback model when remembered and clear persistent state",
    handler: async (_args, ctx) => {
      syncPaths(ctx);
      state = { version: 1, entries: [] };
      await writeState(paths.state, state);
      if (!originalModelKey) {
        ctx.ui.notify("Model fallback: persistent state cleared; no remembered original model.", "info");
        activeFallbackKey = undefined;
        lastFallbackReason = undefined;
        visitedFallbackKeys = new Set();
        updateStatus(ctx);
        return;
      }
      const [provider, ...modelParts] = originalModelKey.split("/");
      const model = ctx.modelRegistry.find(provider, modelParts.join("/"));
      if (!model) {
        ctx.ui.notify(`Model fallback original missing: ${originalModelKey}`, "warning");
        return;
      }
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`Model fallback original auth unavailable: ${originalModelKey}`, "warning");
        return;
      }
      activeFallbackKey = undefined;
      originalModelKey = undefined;
      lastFallbackReason = undefined;
      visitedFallbackKeys = new Set();
      updateStatus(ctx);
      ctx.ui.notify(`Model fallback reset: ${modelKey(model)}; persistent state cleared.`, "info");
    },
  });

  pi.registerTool({
    name: "model_fallback_config",
    label: "Model Fallback Config",
    description: "Read, validate, or save pi-model-fallback configuration.",
    promptSnippet: "Read, validate, or save pi-model-fallback configuration after user asks.",
    promptGuidelines: [
      "Use model_fallback_config when the user asks to inspect or configure model fallback rules.",
      "Use action=save only after preparing the full JSON config; the tool asks for confirmation before writing.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("status"), Type.Literal("validate"), Type.Literal("save")]),
      configJson: Type.Optional(Type.String({ description: "Full ModelFallbackConfig JSON for validate or save." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncPaths(ctx);
      if (params.action === "read" || params.action === "status") {
        const current = await readConfig(paths.config);
        const currentState = await readState(paths.state);
        const warnings = analyzeRuleWarnings(current);
        const details = configToolDetails(paths.config, paths.state, currentState, warnings, activeFallbackKey, originalModelKey, lastFallbackReason);
        const text = params.action === "status"
          ? formatStatus(current, currentState, paths.config, paths.state, warnings, activeFallbackKey, originalModelKey, lastFallbackReason)
          : JSON.stringify(current, null, 2);
        return textResult(text, details);
      }
      if (!params.configJson) throw new Error("configJson is required for validate/save.");
      const nextConfig = validateConfigShape(JSON.parse(params.configJson));
      const warnings = analyzeRuleWarnings(nextConfig);
      validateRegisteredModels(ctx, nextConfig);
      if (params.action === "validate") return textResult(configResultText("Config is valid.", warnings), { config: nextConfig, ...warningDetails(warnings) });
      if (!ctx.hasUI) return textResult("Config not saved: confirmation UI is unavailable.", { configPath: paths.config, ...warningDetails(warnings) });
      const ok = await ctx.ui.confirm("Save model fallback config?", summarizeConfig(nextConfig, warnings));
      if (!ok) return textResult("Config not saved.", { configPath: paths.config, ...warningDetails(warnings) });
      await writeConfig(paths.config, nextConfig);
      config = nextConfig;
      return textResult(configResultText("Config saved.", warnings), { configPath: paths.config, ...warningDetails(warnings) });
    },
  });
}

function autoRetryEnabled(config: ModelFallbackConfig): boolean {
  return config.autoRetry !== false;
}

function lastUserPromptText(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries() as unknown[];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user") continue;
    return userMessageText(message.content);
  }
  return undefined;
}

function userMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

function shouldUseProjectLocalState(ctx: ExtensionContext): boolean {
  const projectSettingsPath = join(ctx.cwd, ".pi", "settings.json");
  return existsSync(projectSettingsPath) && projectSettingsIncludesThisPackage(projectSettingsPath);
}

function projectSettingsIncludesThisPackage(projectSettingsPath: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(projectSettingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || !Array.isArray(settings.packages)) return false;
    return settings.packages.some((entry) => packageEntryMatchesThisPackage(entry, dirname(projectSettingsPath)));
  } catch {
    return false;
  }
}

function packageEntryMatchesThisPackage(entry: unknown, settingsDir: string): boolean {
  const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
  if (!source) return false;
  if (source.includes("pi-model-fallback")) return true;
  return resolve(settingsDir, source) === resolve(PACKAGE_ROOT);
}

function validateRegisteredModels(ctx: ExtensionContext, nextConfig: ModelFallbackConfig): void {
  if (nextConfig.timeoutFallback) {
    const fallback = ctx.modelRegistry.find(nextConfig.timeoutFallback.fallback.provider, nextConfig.timeoutFallback.fallback.model);
    if (!fallback) throw new Error(`Unknown fallback model: ${modelRefKey(nextConfig.timeoutFallback.fallback)}`);
  }
  for (const rule of nextConfig.rules) {
    const fallback = ctx.modelRegistry.find(rule.fallback.provider, rule.fallback.model);
    if (!fallback) throw new Error(`Unknown fallback model: ${modelRefKey(rule.fallback)}`);
  }
}

function parseModelInput(input: string): ModelRef | undefined {
  const trimmed = input.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
    const provider = trimmed.slice(0, slashIdx).trim();
    const model = trimmed.slice(slashIdx + 1).trim();
    if (provider && model) return { provider, model };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { provider: parts[0], model: parts[1] };
  }
  return undefined;
}

function getAvailableModels(ctx: ExtensionContext): Array<{ provider: string; id: string }> {
  try {
    const registry = ctx.modelRegistry as unknown as Record<string, unknown> | undefined;
    if (registry && typeof registry.getAvailable === "function") {
      const models = (registry.getAvailable as () => unknown)();
      if (Array.isArray(models) && models.length > 0) return models as Array<{ provider: string; id: string }>;
    }
    if (registry && typeof registry.getAll === "function") {
      const models = (registry.getAll as () => unknown)();
      if (Array.isArray(models) && models.length > 0) return models as Array<{ provider: string; id: string }>;
    }
  } catch {
    // Ignore registry errors
  }
  return [];
}

function formatTimeoutStatus(config: ModelFallbackConfig): string {
  if (config.timeoutFallback) {
    const stateStr = config.timeoutFallback.enabled !== false ? "enabled" : "disabled";
    return `${stateStr} -> ${modelRefKey(config.timeoutFallback.fallback)}`;
  }
  const rule = config.rules.find((r) => r.reasons?.includes("response_headers_timeout"));
  if (rule) {
    return `enabled via rule "${rule.name ?? "unnamed"}" -> ${modelRefKey(rule.fallback)}`;
  }
  return "not configured";
}

function formatStatus(
  config: ModelFallbackConfig,
  state: FallbackState,
  configPath: string,
  statePath: string,
  warnings: RuleWarning[],
  activeFallbackKey?: string,
  originalModelKey?: string,
  reason?: string,
): string {
  return [
    `Model fallback: ${config.enabled ? "enabled" : "disabled"}`,
    `Timeout fallback: ${formatTimeoutStatus(config)}`,
    `Auto retry: ${autoRetryEnabled(config) ? "enabled" : "disabled"}`,
    `Config: ${configPath}`,
    `State: ${statePath}`,
    `Rules: ${config.rules.length}`,
    `Config warnings: ${warningSummary(warnings)}`,
    `Persistent entries: ${state.entries.length}`,
    ...state.entries.map((entry) => `- ${modelRefKey(entry.source)} -> ${modelRefKey(entry.fallback)} until ${entry.until} (${entry.status})`),
    `Active fallback: ${activeFallbackKey ?? "none"}`,
    `Original model: ${originalModelKey ?? "none"}`,
    `Reason: ${reason ?? "none"}`,
  ].join("\n");
}

function summarizeConfig(config: ModelFallbackConfig, warnings: RuleWarning[]): string {
  return [
    `enabled: ${config.enabled}`,
    `timeoutFallback: ${formatTimeoutStatus(config)}`,
    `autoRetry: ${autoRetryEnabled(config)}`,
    ...config.rules.map((rule) => `${rule.name ?? "rule"}: ${rule.matchProviders?.join(",") ?? "models"} -> ${modelRefKey(rule.fallback)}`),
    `warnings: ${warningSummary(warnings)}`,
  ].join("\n");
}

function configToolDetails(
  configPath: string,
  statePath: string,
  state: FallbackState,
  warnings: RuleWarning[],
  activeFallbackKey?: string,
  originalModelKey?: string,
  lastFallbackReason?: string,
): Record<string, unknown> {
  return {
    configPath,
    statePath,
    state,
    activeFallbackKey,
    originalModelKey,
    lastFallbackReason,
    ...warningDetails(warnings),
  };
}

function warningDetails(warnings: RuleWarning[]): Record<string, unknown> {
  return {
    warningCount: warnings.length,
    warningSummary: warningSummary(warnings),
    warnings,
  };
}

function configResultText(prefix: string, warnings: RuleWarning[]): string {
  if (warnings.length === 0) return prefix;
  return `${prefix} ${warningSummary(warnings)}`;
}

function warningSummary(warnings: RuleWarning[]): string {
  if (warnings.length === 0) return "none";
  if (warnings.length === 1) return `1 warning: ${warnings[0].message}`;
  return `${warnings.length} warnings: ${warnings.map((warning) => warning.message).join("; ")}`;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function cooldownMsFor(ruleCooldownMs: number | undefined, status: number, headers: Record<string, string>): number {
  const baseline = cooldownMsFromHeaders(headers)
    ?? ruleCooldownMs
    ?? (status === 429 ? DEFAULT_429_COOLDOWN_MS : DEFAULT_5XX_COOLDOWN_MS);
  // A configured rule cooldown is a hard cap: server retry/reset headers may shorten it
  // but must never stretch the fallback period beyond what the rule allows.
  return ruleCooldownMs !== undefined ? Math.min(baseline, ruleCooldownMs) : baseline;
}

export { cooldownMsFor };

function cooldownMsFromHeaders(headers: Record<string, string>): number | undefined {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const retryAfter = parseRetryAfter(normalized["retry-after"]);
  if (retryAfter !== undefined) return retryAfter;

  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "ratelimit-reset", "x-rate-limit-reset"]) {
    const parsed = parseResetHeader(normalized[name]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs) && dateMs > Date.now()) return dateMs - Date.now();
  return undefined;
}

function parseResetHeader(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1_000_000_000_000) return Math.max(0, numeric - Date.now());
    if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - Date.now());
    return Math.ceil(numeric * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs) && dateMs > Date.now()) return dateMs - Date.now();
  return undefined;
}

function modelToRef(model: { provider: string; id: string }): ModelRef {
  return { provider: model.provider, model: model.id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

