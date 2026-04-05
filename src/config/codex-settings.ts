import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getWorkspaceRoot } from "../runtime/state-paths.js";

export type ReviewScope = "auto" | "working-tree" | "branch";

export interface CodexSettings {
  defaultReviewScope: ReviewScope;
  defaultReviewModel?: string;
  reviewHistoryLimit: number;
  protectLockfiles: boolean;
  enableTaskCommand: boolean;
  enableResearchCommand: boolean;
  protectedPaths: string[];
}

type SettingsExtensionShape = Record<string, Record<string, string | undefined>>;

const DEFAULT_SETTINGS: CodexSettings = {
  defaultReviewScope: "auto",
  defaultReviewModel: undefined,
  reviewHistoryLimit: 25,
  protectLockfiles: false,
  enableTaskCommand: true,
  enableResearchCommand: true,
  protectedPaths: [".env", ".git/", "node_modules/"],
};

function parseJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function globalSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function globalExtensionSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings-extensions.json");
}

function projectSettingsPath(cwd: string): string {
  const workspaceRoot = getWorkspaceRoot(cwd);
  let current = cwd;

  while (true) {
    const candidate = join(current, ".pi", "settings.json");
    if (existsSync(candidate)) {
      return candidate;
    }

    if (current === workspaceRoot) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return join(workspaceRoot, ".pi", "settings.json");
}

function normalizeScope(value: unknown): ReviewScope | undefined {
  return value === "auto" || value === "working-tree" || value === "branch" ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true" || lowered === "on" || lowered === "yes") {
      return true;
    }
    if (lowered === "false" || lowered === "off" || lowered === "no") {
      return false;
    }
  }
  return undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed);
    }
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : [];
  }
  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : [];
  }
  return undefined;
}

function applyPartial(target: CodexSettings, source: unknown): CodexSettings {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return target;
  }

  const value = source as Record<string, unknown>;
  return {
    defaultReviewScope: normalizeScope(value.defaultReviewScope) ?? target.defaultReviewScope,
    defaultReviewModel:
      typeof value.defaultReviewModel === "string" && value.defaultReviewModel.trim()
        ? value.defaultReviewModel.trim()
        : target.defaultReviewModel,
    reviewHistoryLimit: normalizePositiveInt(value.reviewHistoryLimit) ?? target.reviewHistoryLimit,
    protectLockfiles: normalizeBoolean(value.protectLockfiles) ?? target.protectLockfiles,
    enableTaskCommand: normalizeBoolean(value.enableTaskCommand) ?? target.enableTaskCommand,
    enableResearchCommand: normalizeBoolean(value.enableResearchCommand) ?? target.enableResearchCommand,
    protectedPaths: normalizeStringArray(value.protectedPaths) ?? target.protectedPaths,
  };
}

function extensionSettingsPartial(): Partial<CodexSettings> {
  const settings = parseJsonFile<SettingsExtensionShape>(globalExtensionSettingsPath());
  const codex = settings?.codex ?? {};
  const partial: Partial<CodexSettings> = {};

  const defaultReviewScope = normalizeScope(codex.defaultReviewScope);
  if (defaultReviewScope !== undefined) {
    partial.defaultReviewScope = defaultReviewScope;
  }

  const defaultReviewModel = codex.defaultReviewModel?.trim();
  if (defaultReviewModel) {
    partial.defaultReviewModel = defaultReviewModel;
  }

  const reviewHistoryLimit = normalizePositiveInt(codex.reviewHistoryLimit);
  if (reviewHistoryLimit !== undefined) {
    partial.reviewHistoryLimit = reviewHistoryLimit;
  }

  const protectLockfiles = normalizeBoolean(codex.protectLockfiles);
  if (protectLockfiles !== undefined) {
    partial.protectLockfiles = protectLockfiles;
  }

  const enableTaskCommand = normalizeBoolean(codex.enableTaskCommand);
  if (enableTaskCommand !== undefined) {
    partial.enableTaskCommand = enableTaskCommand;
  }

  const enableResearchCommand = normalizeBoolean(codex.enableResearchCommand);
  if (enableResearchCommand !== undefined) {
    partial.enableResearchCommand = enableResearchCommand;
  }

  return partial;
}

export function loadCodexSettings(cwd: string): CodexSettings {
  let merged = { ...DEFAULT_SETTINGS };

  merged = { ...merged, ...extensionSettingsPartial() };

  const globalSettings = parseJsonFile<Record<string, unknown>>(globalSettingsPath());
  merged = applyPartial(merged, globalSettings?.codex);

  const projectSettings = parseJsonFile<Record<string, unknown>>(projectSettingsPath(cwd));
  merged = applyPartial(merged, projectSettings?.codex);

  const protectedPaths = [...merged.protectedPaths];
  if (merged.protectLockfiles) {
    protectedPaths.push("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb");
  }
  merged.protectedPaths = Array.from(new Set(protectedPaths));

  return merged;
}

export function registerCodexSettings(pi: ExtensionAPI): void {
  pi.events.emit("pi-extension-settings:register", {
    name: "codex",
    settings: [
      {
        id: "defaultReviewScope",
        label: "Default Review Scope",
        description: "Which repository state /codex:review should inspect by default.",
        defaultValue: DEFAULT_SETTINGS.defaultReviewScope,
        values: ["auto", "working-tree", "branch"],
      },
      {
        id: "defaultReviewModel",
        label: "Default Review Model",
        description: "Optional provider/model override used for Codex reviews.",
        defaultValue: "",
      },
      {
        id: "reviewHistoryLimit",
        label: "Review History Limit",
        description: "Maximum stored reviews per workspace.",
        defaultValue: String(DEFAULT_SETTINGS.reviewHistoryLimit),
        values: ["10", "25", "50", "100"],
      },
      {
        id: "protectLockfiles",
        label: "Protect Lockfiles",
        description: "Block writes to common lockfiles unless explicitly disabled.",
        defaultValue: "off",
        values: ["on", "off"],
      },
      {
        id: "enableTaskCommand",
        label: "Enable Task Command",
        description: "Allow /codex:task to hand work back into the live PI session.",
        defaultValue: "on",
        values: ["on", "off"],
      },
      {
        id: "enableResearchCommand",
        label: "Enable Research Command",
        description: "Allow /codex:research to hand off evidence-first research into the live PI session.",
        defaultValue: "on",
        values: ["on", "off"],
      },
    ],
  });
}

export function renderSettingsMarkdown(settings: CodexSettings, currentModelLabel: string | null): string {
  const lines = [
    "# Codex Config",
    "",
    `- Current session model: ${currentModelLabel ?? "none"}`,
    `- Default review scope: ${settings.defaultReviewScope}`,
    `- Default review model: ${settings.defaultReviewModel ?? "(use current session model)"}`,
    `- Review history limit: ${settings.reviewHistoryLimit}`,
    `- Protect lockfiles: ${settings.protectLockfiles ? "on" : "off"}`,
    `- Enable task command: ${settings.enableTaskCommand ? "on" : "off"}`,
    `- Enable research command: ${settings.enableResearchCommand ? "on" : "off"}`,
    "",
    "Protected paths:",
    ...settings.protectedPaths.map((entry) => `- ${entry}`),
    "",
    "Use `/extension-settings` to edit the global extension-backed values.",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}
