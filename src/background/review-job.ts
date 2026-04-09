import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { CodexSettings } from "../config/codex-settings.js";
import { createSessionActivityWatchdog } from "./session-activity.js";
import {
  appendJobLog,
  createReviewBackgroundJob,
  generateJobId,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  readBackgroundJob,
  readReviewSnapshot,
  updateBackgroundJob,
  writeReviewJobResult,
} from "../runtime/job-store.js";
import type { ReviewBackgroundJob, ReviewSnapshot } from "../runtime/job-types.js";
import { resolveSessionIdentity } from "../runtime/session-identity.js";
import {
  buildBackgroundReviewToolPlan,
} from "../runtime/session-prompts.js";
import { BACKGROUND_READONLY_ENV } from "../runtime/path-protection.js";
import { collectReviewContext, resolveReviewTarget } from "../review/git-context.js";
import type { StoredReviewRun } from "../review/review-schema.js";
import { renderStoredReviewMarkdown } from "../review/review-render.js";
import {
  buildReviewInspectionPrompt,
  executePreparedReviewRun,
  generateInspectionSeedNotesWithCompletion,
  requireModelAuth,
  resolveModel,
  type ReviewCommandOptions,
} from "../review/review-runner.js";
import { resolveEffectiveThinkingLevel } from "../runtime/thinking.js";
import { reviewKindIdPrefix, type CodexReviewKind } from "../review/review-kind.js";

const INTERNAL_REVIEW_JOB_COMMAND = "codex:internal-run-review-job";
const CURRENT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/core/index.ts", import.meta.url));
const MAX_REVIEW_JOB_DURATION_MS = 15 * 60 * 1_000;
const MAX_REVIEW_JOB_IDLE_MS = 5 * 60 * 1_000;
const MAX_MENTAL_MODELS_REVIEW_JOB_DURATION_MS = 25 * 60 * 1_000;
const MAX_FOREGROUND_AGENTIC_REVIEW_DURATION_MS = 20 * 60 * 1_000;

type ReviewJobRuntime = {
  executeReview?: typeof executePreparedReviewRun;
  timeoutMs?: number;
};

type ReviewTurnWaitOptions = {
  prompt: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxToolCalls?: number;
  sessionDir?: string;
  activateToolNames?: string[];
  onDispatch?: () => void;
  onLog?: (message: string) => void;
  deliverAs?: "followUp";
};

type AgenticStructuredReviewOptions = {
  targetLabel: string;
  focusText?: string;
  reviewInput: string;
  seedInspectionNotes?: string;
  activeToolNames: string[];
  activeWebTools: string[];
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxToolCalls?: number;
  sessionDir?: string;
  onLog?: (message: string) => void;
  deliverAs?: "followUp";
};

type AgentMessageLike = {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  errorMessage?: string;
  stopReason?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cliEntryPoint(): string {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Unable to determine the current PI CLI entrypoint for background execution.");
  }
  return entry;
}

function modelSpec(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function extractAssistantText(messages: AgentMessageLike[] | undefined): string {
  if (!messages || messages.length === 0) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      const trimmed = message.content.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }

    if (message.errorMessage?.trim()) {
      return message.errorMessage.trim();
    }
  }

  return "";
}

function isTerminalAssistantMessage(message: AgentMessageLike | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason && stopReason !== "stop" && stopReason !== "endTurn") {
    return false;
  }
  if (Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall")) {
    return false;
  }
  return extractAssistantText([message]).length > 0;
}

function isToolUseTurn(message: AgentMessageLike | undefined): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  if (typeof message.stopReason === "string" && message.stopReason === "toolUse") {
    return true;
  }
  return Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall");
}

function inspectionToolCallBudget(kind: CodexReviewKind): number {
  switch (kind) {
    case "review":
      return 16;
    case "adversarial-review":
      return 20;
    case "adversarial-mental-models-review":
      return 24;
    default:
      return 18;
  }
}

function extractReviewSection(reviewInput: string, title: string): string | null {
  const match = reviewInput.match(new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?:\\n## |$)`));
  if (!match) {
    return null;
  }
  return match[1]?.trim() || null;
}

function estimateChangedPathCount(reviewInput: string): number {
  const branchChangedFiles = extractReviewSection(reviewInput, "Changed Files");
  if (branchChangedFiles) {
    return branchChangedFiles
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "(none)")
      .length;
  }

  const gitStatus = extractReviewSection(reviewInput, "Git Status");
  if (gitStatus) {
    return gitStatus
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "(none)")
      .length;
  }

  const untracked = reviewInput.match(/^### /gm);
  return untracked?.length ?? 0;
}

function inspectionSurfaceBudgetBonus(reviewInput: string): number {
  const changedPathCount = estimateChangedPathCount(reviewInput);
  if (changedPathCount >= 100) {
    return 8;
  }
  if (changedPathCount >= 50) {
    return 6;
  }
  if (changedPathCount >= 20) {
    return 4;
  }
  if (changedPathCount >= 8) {
    return 2;
  }
  return 0;
}

function inspectionToolCallBudgetForReview(kind: CodexReviewKind, reviewInput: string): number {
  return inspectionToolCallBudget(kind) + inspectionSurfaceBudgetBonus(reviewInput);
}

function buildAgenticReviewPrompt(
  basePrompt: string,
  activeToolNames: string[],
  activeWebTools: string[],
  seedInspectionNotes?: string,
): string {
  const availableTools = activeToolNames.length > 0 ? activeToolNames.join(", ") : "none";
  const availableWebTools = activeWebTools.length > 0 ? activeWebTools.join(", ") : "none";
  const activeNames = new Set(activeToolNames);
  const activeReadOnlyInspectionTools = ["read", "grep", "find", "ls"].filter((toolName) => activeNames.has(toolName));
  const bashAvailable = activeNames.has("bash");
  const trimmedSeeds = seedInspectionNotes?.trim();
  return [
    basePrompt,
    "",
    ...(trimmedSeeds
      ? [
          "<seed_hypotheses>",
          "Start from these diff-only hypotheses and adjacent evidence targets before expanding outward.",
          "Use tools to verify, dismiss, or sharpen them. Only add new hypotheses if the seeded ones collapse or reveal a broader adjacent risk.",
          trimmedSeeds,
          "</seed_hypotheses>",
          "",
        ]
      : []),
    "<tooling_rules>",
    "Use the available repository inspection tools to verify, deepen, and challenge the provided repository context before finalizing.",
    `Active tools for this review worker: ${availableTools}.`,
    `Active web tools for this review worker: ${availableWebTools}.`,
    activeReadOnlyInspectionTools.length > 0
      ? `Prefer the active read-only inspection tools (${activeReadOnlyInspectionTools.join(", ")}) for direct repository inspection.`
      : bashAvailable
        ? "No dedicated read-only inspection builtins are active beyond `bash`."
        : "No dedicated repository-inspection builtins are active in this worker.",
    bashAvailable
      ? "Use read-only `bash` for git-aware inspection when needed, including commands like `git diff`, `git show`, `git log`, `git status`, `git rev-parse`, `git ls-files`, `git grep`, `git blame`, and `git merge-base`."
      : "`bash` is not active in this review worker, so rely on the active inspection tools only.",
    bashAvailable
      ? "Multi-step read-only inspection is allowed when it reduces turns, such as `git status --short && git diff -- <paths>` or `git show HEAD:<path> | sed -n '1,120p'`."
      : "Do not ask for unavailable shell tools; use the active inspection tools already exposed in this worker.",
    bashAvailable
      ? "Prefer diff/show/status/log inspection before history archaeology. Use `git blame` or broader history only when it is needed to confirm or dismiss a concrete regression hypothesis."
      : "Keep the inspection bounded to the most relevant active tools and nearby evidence.",
    "This review worker is read-only. Do not edit files, write files, or run mutating shell commands.",
    "For each serious candidate finding, inspect the changed code, the nearby guard or caller, and any relevant test or previous-version context before finalizing.",
    "If a likely issue depends on a nearby guard, call site, test, rollback path, or ordering assumption, inspect it before finalizing.",
    "Keep the inspection bounded. Do not exhaustively traverse unrelated files, entire directories, or broad history unless that additional evidence is needed to resolve a top-risk hypothesis.",
    "The final assistant message for this turn must follow the requested markdown heading format exactly.",
    "Do not return JSON in this turn unless the base prompt explicitly asks for it.",
    "</tooling_rules>",
  ].join("\n");
}

type PendingReviewTurnRecord = {
  prompt: string;
  awaitingAgentEnd: boolean;
  matchedAgentStart: boolean;
  assignedTurnIndex: number | null;
  foregroundReadOnlyActive: boolean;
  observedToolTurns: number;
  maxToolCalls?: number;
  cancellationRequested: () => boolean;
  desiredActiveToolNames: string[];
  previousToolNames: string[] | null;
  toolSurfaceActive: boolean;
  onLog?: (message: string) => void;
  resolveOnce: (value: string) => void;
  rejectOnce: (error: Error) => void;
};

const reviewTurnBridgeApis = new WeakSet<object>();
const pendingReviewTurns: PendingReviewTurnRecord[] = [];
let foregroundReviewReadOnlyDepth = 0;

export function isForegroundReviewReadOnlyActive(): boolean {
  return foregroundReviewReadOnlyDepth > 0;
}

function activateForegroundReviewTurn(pi: ExtensionAPI, record: PendingReviewTurnRecord): void {
  if (!record.toolSurfaceActive) {
    record.previousToolNames = Array.from(new Set(pi.getActiveTools())).sort((left, right) => left.localeCompare(right));
    pi.setActiveTools(record.desiredActiveToolNames);
    record.toolSurfaceActive = true;
  }
  if (!record.foregroundReadOnlyActive) {
    foregroundReviewReadOnlyDepth += 1;
    record.foregroundReadOnlyActive = true;
  }
}

function removePendingReviewTurn(pi: ExtensionAPI, record: PendingReviewTurnRecord): void {
  const index = pendingReviewTurns.indexOf(record);
  if (index >= 0) {
    pendingReviewTurns.splice(index, 1);
  }
  if (record.toolSurfaceActive) {
    pi.setActiveTools(record.previousToolNames ?? []);
    record.toolSurfaceActive = false;
    record.previousToolNames = null;
  }
  if (record.foregroundReadOnlyActive) {
    foregroundReviewReadOnlyDepth = Math.max(0, foregroundReviewReadOnlyDepth - 1);
    record.foregroundReadOnlyActive = false;
  }
}

function ensureReviewTurnEventBridge(pi: ExtensionAPI): void {
  if (reviewTurnBridgeApis.has(pi as object)) {
    return;
  }
  reviewTurnBridgeApis.add(pi as object);

  pi.on("before_agent_start", (event) => {
    for (const record of pendingReviewTurns) {
      if (record.matchedAgentStart || event.prompt !== record.prompt) {
        continue;
      }
      record.matchedAgentStart = true;
      activateForegroundReviewTurn(pi, record);
      record.onLog?.("Observed matching review agent start.");
      break;
    }
  });

  pi.on("turn_start", async (event) => {
    const record = pendingReviewTurns[0];
    if (!record?.awaitingAgentEnd || record.assignedTurnIndex != null) {
      return;
    }
    if (!record.matchedAgentStart) {
      record.matchedAgentStart = true;
      activateForegroundReviewTurn(pi, record);
      record.onLog?.("Accepted turn_start fallback without matching before_agent_start.");
    }
    record.assignedTurnIndex = event.turnIndex;
    record.onLog?.(`Observed review turn start ${event.turnIndex}.`);
  });

  pi.on("turn_end", async (event) => {
    const record = pendingReviewTurns[0];
    if (!record?.awaitingAgentEnd) {
      return;
    }
    if (record.assignedTurnIndex == null) {
      if (!record.matchedAgentStart) {
        record.matchedAgentStart = true;
        activateForegroundReviewTurn(pi, record);
        record.onLog?.("Accepted turn_end fallback without matching before_agent_start/turn_start.");
      }
      if (event.turnIndex != null) {
        record.assignedTurnIndex = event.turnIndex;
      }
    }
    if (record.assignedTurnIndex != null && event.turnIndex != null && event.turnIndex !== record.assignedTurnIndex) {
      return;
    }
    const terminalMessage = event.message as AgentMessageLike | undefined;
    if (!isTerminalAssistantMessage(terminalMessage)) {
      if (record.maxToolCalls && isToolUseTurn(terminalMessage)) {
        record.observedToolTurns += 1;
        record.onLog?.(`Inspection used ${record.observedToolTurns}/${record.maxToolCalls} tool turns.`);
        if (record.observedToolTurns > record.maxToolCalls) {
          record.rejectOnce(
            new Error(`Review inspection exceeded ${record.maxToolCalls} tool turns without producing a terminal assistant result.`),
          );
        }
      }
      return;
    }

    const text = terminalMessage ? extractAssistantText([terminalMessage]) : "";
    record.resolveOnce(text);
  });
}

function spawnDetachedReviewWorker(job: ReviewBackgroundJob): number | null {
  const stdout = openSync(job.logFile, "a", 0o600);
  const stderr = openSync(job.logFile, "a", 0o600);
  try {
    const args = [
      cliEntryPoint(),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      CURRENT_EXTENSION_PATH,
      ...((job.extensionPaths ?? []).flatMap((extensionPath) => ["--extension", extensionPath])),
      "--tools",
      (job.requestedToolNames ?? ["read", "grep", "find", "ls", "bash"]).join(","),
      "--model",
      job.modelSpec,
      ...(job.thinkingLevel ? ["--thinking", job.thinkingLevel] : []),
      ...(job.sessionDir ? ["--session-dir", job.sessionDir] : []),
      "-p",
      `/${INTERNAL_REVIEW_JOB_COMMAND} ${job.id}`,
    ];

    const child = spawn(process.execPath, args, {
      cwd: job.repoRoot,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, [BACKGROUND_READONLY_ENV]: "1" },
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function launchBackgroundReviewJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  kind: CodexReviewKind,
  options: ReviewCommandOptions,
): Promise<ReviewBackgroundJob> {
  const sessionIdentity = resolveSessionIdentity(ctx);
  const target = resolveReviewTarget(ctx.cwd, {
    scope: options.scope ?? settings.defaultReviewScope,
    base: options.base,
  });
  const reviewContext = collectReviewContext(ctx.cwd, target);
  const model = resolveModel(ctx, settings, options.modelSpec);
  await requireModelAuth(ctx, model);
  const toolPlan = buildBackgroundReviewToolPlan(pi);
  const thinkingLevel = resolveEffectiveThinkingLevel(model, options.thinkingLevel);
  const id = generateJobId(reviewKindIdPrefix(kind));
  const createdAt = nowIso();
  const sessionDir = getJobSessionDir(reviewContext.repoRoot, id);

  const snapshot: ReviewSnapshot = {
    kind,
    repoRoot: reviewContext.repoRoot,
    branch: reviewContext.branch,
    targetLabel: reviewContext.target.label,
    targetMode: reviewContext.target.mode,
    targetBaseRef: reviewContext.target.baseRef,
    focusText: options.focusText?.trim() || undefined,
    modelSpec: modelSpec(model.provider, model.id),
    thinkingLevel,
    requestedToolNames: toolPlan.requestedToolNames,
    safeBuiltinTools: toolPlan.safeBuiltinTools,
    activeWebTools: toolPlan.activatedWebTools,
    inactiveAvailableWebTools: toolPlan.interactiveSnapshot.inactiveAvailableWebTools
      .filter((toolName) => !toolPlan.activatedWebTools.includes(toolName)),
    extensionPaths: toolPlan.extensionPaths,
    reviewInput: reviewContext.content,
  };

  const job: ReviewBackgroundJob = {
    id,
    jobClass: "review",
    kind,
    workspaceRoot: reviewContext.repoRoot,
    cwd: ctx.cwd,
    repoRoot: reviewContext.repoRoot,
    branch: reviewContext.branch,
    originSessionId: sessionIdentity.id,
    originSessionFile: sessionIdentity.file,
    originCwd: sessionIdentity.cwd,
    targetLabel: reviewContext.target.label,
    targetMode: reviewContext.target.mode,
    targetBaseRef: reviewContext.target.baseRef,
    focusText: snapshot.focusText,
    modelProvider: model.provider,
    modelId: model.id,
    modelSpec: snapshot.modelSpec,
    thinkingLevel,
    requestedToolNames: snapshot.requestedToolNames,
    activeToolNames: [],
    safeBuiltinTools: snapshot.safeBuiltinTools,
    activeWebTools: snapshot.activeWebTools,
    inactiveAvailableWebTools: snapshot.inactiveAvailableWebTools,
    extensionPaths: snapshot.extensionPaths,
    sessionDir,
    createdAt,
    updatedAt: createdAt,
    status: "queued",
    phase: "queued",
    snapshotFile: getJobSnapshotFile(reviewContext.repoRoot, id),
    resultFile: getJobResultFile(reviewContext.repoRoot, id),
    resultJsonFile: getJobResultJsonFile(reviewContext.repoRoot, id),
    logFile: getJobLogFile(reviewContext.repoRoot, id),
  };

  createReviewBackgroundJob(job, snapshot);
  appendJobLog(job.workspaceRoot, job.id, "Queued background review job.");

  const runnerPid = spawnDetachedReviewWorker(job);
  const launchedAt = nowIso();
  const launched = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    runnerPid,
    status: "starting",
    phase: "starting",
    updatedAt: launchedAt,
  })) as ReviewBackgroundJob;

  appendJobLog(launched.workspaceRoot, launched.id, runnerPid ? `Spawned background worker pid ${runnerPid}.` : "Spawned background worker.");
  return launched;
}

export async function executeForegroundReviewRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  kind: CodexReviewKind,
  options: ReviewCommandOptions,
): Promise<StoredReviewRun> {
  const target = resolveReviewTarget(ctx.cwd, {
    scope: options.scope ?? settings.defaultReviewScope,
    base: options.base,
  });
  const reviewContext = collectReviewContext(ctx.cwd, target);
  const model = resolveModel(ctx, settings, options.modelSpec);
  await requireModelAuth(ctx, model);
  const thinkingLevel = resolveEffectiveThinkingLevel(model, options.thinkingLevel);
  const seedInspectionNotes = await generateInspectionSeedNotesWithCompletion(
    ctx,
    model,
    reviewContext.target.label,
    options.focusText,
    reviewContext.content,
    thinkingLevel,
  );
  const toolPlan = buildBackgroundReviewToolPlan(pi);
  const idle = typeof (ctx as { isIdle?: () => boolean }).isIdle === "function"
    ? (ctx as { isIdle: () => boolean }).isIdle()
    : true;
  const deliverAs = idle ? undefined : "followUp";
  const availableToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
  const activeToolNames = toolPlan.requestedToolNames.filter((toolName) => availableToolNames.has(toolName));
  const activeWebTools = toolPlan.activatedWebTools.filter((toolName) => availableToolNames.has(toolName));
  const inspectionNotes = await executeAgenticInspectionNotes(pi, ctx, {
    targetLabel: reviewContext.target.label,
    focusText: options.focusText,
    reviewInput: reviewContext.content,
    seedInspectionNotes,
    activeToolNames,
    activeWebTools,
    timeoutMs: MAX_FOREGROUND_AGENTIC_REVIEW_DURATION_MS,
    maxToolCalls: inspectionToolCallBudgetForReview(kind, reviewContext.content),
    deliverAs,
  });
  return executePreparedReviewRun(
    ctx,
    settings,
    {
      kind,
      repoRoot: reviewContext.repoRoot,
      branch: reviewContext.branch,
      targetLabel: reviewContext.target.label,
      targetMode: reviewContext.target.mode,
      targetBaseRef: reviewContext.target.baseRef,
      reviewInput: reviewContext.content,
      modelSpec: options.modelSpec,
      thinkingLevel,
      focusText: options.focusText,
    },
    { inspectionNotes },
  );
}

function markCancelled(workspaceRoot: string, jobId: string, reason: string): ReviewBackgroundJob {
  const cancelledAt = nowIso();
  const next = updateBackgroundJob(workspaceRoot, jobId, (current) => ({
    ...current,
    status: "cancelled",
    phase: "cancelled",
    updatedAt: cancelledAt,
    cancelledAt: current.cancelledAt ?? cancelledAt,
    runnerPid: null,
    errorMessage: undefined,
  })) as ReviewBackgroundJob;
  appendJobLog(workspaceRoot, jobId, reason);
  return next;
}

async function waitForReviewAgentTurn(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: ReviewTurnWaitOptions,
): Promise<string> {
  const {
    prompt,
    timeoutMs,
    idleTimeoutMs = MAX_REVIEW_JOB_IDLE_MS,
    maxToolCalls,
    sessionDir,
    activateToolNames = [],
    onDispatch,
    onLog,
    deliverAs,
  } = options;
  let cancellationRequested = false;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const signalHandler = (signal: NodeJS.Signals) => {
    cancellationRequested = true;
    rejectCompletion?.(new Error(`Review cancelled by ${signal}.`));
    try {
      ctx.abort();
    } catch {
      // Best effort only.
    }
  };

  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);

  try {
    ensureReviewTurnEventBridge(pi);
    return await new Promise<string>((resolve, reject) => {
      if (pendingReviewTurns.some((record) => record.awaitingAgentEnd)) {
        reject(new Error("Another review inspection turn is already pending in this PI session."));
        return;
      }

      let settled = false;
      const watchdog = sessionDir
        ? createSessionActivityWatchdog({
            sessionDir,
            idleTimeoutMs,
            hardTimeoutMs: timeoutMs,
            onTimeout: (kind) => {
              const message =
                kind === "idle"
                  ? `Background review was idle for ${Math.round(idleTimeoutMs / 1_000)}s without new session activity.`
                  : `Background review exceeded ${Math.round(timeoutMs / 1_000)}s without reaching a terminal review result.`;
              rejectCompletion?.(new Error(message));
            },
          })
        : null;
      const hardTimeout = sessionDir
        ? null
        : setTimeout(() => {
            rejectCompletion?.(new Error(`Review exceeded ${Math.round(timeoutMs / 1_000)}s without reaching a terminal review result.`));
          }, timeoutMs);
      hardTimeout?.unref?.();
      const requestedToolNames = Array.from(new Set(activateToolNames)).sort((left, right) => left.localeCompare(right));
      const settle = () => {
        watchdog?.clear();
        if (hardTimeout) {
          clearTimeout(hardTimeout);
        }
        removePendingReviewTurn(pi, record);
        rejectCompletion = null;
      };
      rejectCompletion = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (record.toolSurfaceActive || record.matchedAgentStart || record.assignedTurnIndex != null) {
          cancellationRequested = true;
          try {
            ctx.abort();
          } catch {
            // Best effort only.
          }
        }
        settle();
        reject(error);
      };
      const resolveOnce = (value: string) => {
        if (settled) {
          return;
        }
        settled = true;
        settle();
        resolve(value);
      };
      const record: PendingReviewTurnRecord = {
        prompt,
        awaitingAgentEnd: true,
        matchedAgentStart: false,
        assignedTurnIndex: null,
        foregroundReadOnlyActive: false,
        observedToolTurns: 0,
        maxToolCalls,
        cancellationRequested: () => cancellationRequested,
        desiredActiveToolNames: requestedToolNames,
        previousToolNames: null,
        toolSurfaceActive: false,
        onLog,
        resolveOnce,
        rejectOnce: (error) => {
          rejectCompletion?.(error);
        },
      };
      if (deliverAs !== "followUp") {
        record.matchedAgentStart = true;
        activateForegroundReviewTurn(pi, record);
        record.onLog?.("Armed foreground review inspection before dispatch.");
      }
      pendingReviewTurns.push(record);
      onDispatch?.();
      try {
        pi.sendUserMessage(prompt, deliverAs ? { deliverAs } : undefined);
      } catch (error) {
        record.rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
  }
}

async function executeAgenticInspectionNotes(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: AgenticStructuredReviewOptions,
): Promise<string> {
  const inspectionPrompt = buildAgenticReviewPrompt(
    buildReviewInspectionPrompt(options.targetLabel, options.focusText, options.reviewInput),
    options.activeToolNames,
    options.activeWebTools,
    options.seedInspectionNotes,
  );
  options.onLog?.("Dispatching inspection review prompt.");
  return waitForReviewAgentTurn(pi, ctx, {
    prompt: inspectionPrompt,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    maxToolCalls: options.maxToolCalls,
    sessionDir: options.sessionDir,
    activateToolNames: options.activeToolNames,
    onLog: options.onLog,
    deliverAs: options.deliverAs,
  });
}

export async function runDetachedReviewJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  jobId: string,
  runtime: ReviewJobRuntime = {},
): Promise<ReviewBackgroundJob> {
  const baseJob = readBackgroundJob(ctx.cwd, jobId);
  if (!baseJob || baseJob.jobClass !== "review") {
    throw new Error(`Unknown background job "${jobId}".`);
  }
  const job = baseJob as ReviewBackgroundJob;

  const snapshot = readReviewSnapshot(job.workspaceRoot, job.id);
  if (!snapshot) {
    throw new Error(`Missing review snapshot for "${job.id}".`);
  }

  const cancelledBeforeStart = readBackgroundJob(ctx.cwd, job.id);
  if (cancelledBeforeStart?.status === "cancelled" || cancelledBeforeStart?.status === "cancelling") {
    appendJobLog(job.workspaceRoot, job.id, "Job was already cancelled before execution started.");
    return markCancelled(job.workspaceRoot, job.id, "Job was already cancelled before execution started.");
  }

  const abortController = new AbortController();
  const executeReview = runtime.executeReview ?? executePreparedReviewRun;
  const timeoutMs = runtime.timeoutMs ?? (snapshot.kind === "adversarial-mental-models-review"
    ? MAX_MENTAL_MODELS_REVIEW_JOB_DURATION_MS
    : MAX_REVIEW_JOB_DURATION_MS);
  const inspectionPassEnabled = !runtime.executeReview;
  let cancellationRequested = false;
  let timeoutRequested = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let runningPhase = inspectionPassEnabled ? "preparing-tools" : "model-completion";
  let rejectAgentTurn: ((error: Error) => void) | null = null;
  const signalHandler = (signal: NodeJS.Signals) => {
    cancellationRequested = true;
    rejectAgentTurn?.(new Error(`Background review received ${signal}.`));
    try {
      ctx.abort();
    } catch {
      // Best effort only.
    }
    abortController.abort(new Error(`Background review received ${signal}.`));
    try {
      markCancelled(job.workspaceRoot, job.id, `Runner received ${signal}; marking job cancelled.`);
    } catch {
      // Best effort during process teardown.
    }
  };

  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);

  const heartbeat = setInterval(() => {
    try {
      updateBackgroundJob(job.workspaceRoot, job.id, (current) => {
        if (current.status === "cancelled") {
          return current;
        }
        if (current.status === "cancelling") {
          if (!cancellationRequested) {
            cancellationRequested = true;
            rejectAgentTurn?.(new Error("Background review cancellation requested."));
            try {
              ctx.abort();
            } catch {
              // Best effort only.
            }
            abortController.abort(new Error("Background review cancellation requested."));
            appendJobLog(job.workspaceRoot, job.id, "Observed cancellation request from job state.");
          }
          return {
            ...current,
            updatedAt: nowIso(),
            lastHeartbeatAt: nowIso(),
            runnerPid: process.pid,
          };
        }
        return {
          ...current,
          status: "running",
          phase: runningPhase,
          updatedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
          runnerPid: process.pid,
        };
      });
    } catch {
      // Best effort heartbeat only.
    }
  }, 2_000);
  heartbeat.unref();

  const startedAt = nowIso();
  updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    status: "running",
    phase: runningPhase,
    updatedAt: startedAt,
    startedAt: current.startedAt ?? startedAt,
    lastHeartbeatAt: startedAt,
    runnerPid: process.pid,
  }));
  appendJobLog(job.workspaceRoot, job.id, "Background review execution started.");
  timeoutHandle = setTimeout(() => {
    timeoutRequested = true;
    const message = `Background review exceeded ${Math.round(timeoutMs / 1_000)}s without reaching a terminal review result.`;
    appendJobLog(job.workspaceRoot, job.id, message);
    rejectAgentTurn?.(new Error(message));
    abortController.abort(new Error(message));
  }, timeoutMs);
  timeoutHandle.unref();

  try {
    let reviewRun: StoredReviewRun;
    let inspectionNotes: string | undefined;
    let seedInspectionNotes: string | undefined;
    if (inspectionPassEnabled) {
      const model = resolveModel(ctx, settings, snapshot.modelSpec);
      await requireModelAuth(ctx, model);
      seedInspectionNotes = await generateInspectionSeedNotesWithCompletion(
        ctx,
        model,
        snapshot.targetLabel,
        snapshot.focusText,
        snapshot.reviewInput,
        snapshot.thinkingLevel,
        abortController.signal,
      );
      const availableToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
      const activeToolNames = (snapshot.requestedToolNames ?? ["bash", "find", "grep", "ls", "read"])
        .filter((toolName) => availableToolNames.has(toolName));
      const missingToolNames = (snapshot.requestedToolNames ?? []).filter((toolName) => !availableToolNames.has(toolName));
      pi.setActiveTools(activeToolNames);
      runningPhase = "agent-turn";
      updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
        ...current,
        phase: "agent-turn",
        updatedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        runnerPid: process.pid,
        activeToolNames,
        missingToolNames,
      }));
      appendJobLog(job.workspaceRoot, job.id, `Activated tools: ${activeToolNames.join(", ") || "none"}.`);
      if (missingToolNames.length > 0) {
        appendJobLog(job.workspaceRoot, job.id, `Missing requested tools: ${missingToolNames.join(", ")}.`);
      }

      inspectionNotes = await new Promise<string>((resolve, reject) => {
        rejectAgentTurn = reject;
        executeAgenticInspectionNotes(pi, ctx, {
          targetLabel: snapshot.targetLabel,
          focusText: snapshot.focusText,
          reviewInput: snapshot.reviewInput,
          seedInspectionNotes,
          activeToolNames,
          activeWebTools: snapshot.activeWebTools ?? [],
          timeoutMs,
          idleTimeoutMs: MAX_REVIEW_JOB_IDLE_MS,
          maxToolCalls: inspectionToolCallBudgetForReview(snapshot.kind, snapshot.reviewInput),
          sessionDir: job.sessionDir,
          onLog: (message) => appendJobLog(job.workspaceRoot, job.id, message),
        })
          .then(resolve)
          .catch(reject)
          .finally(() => {
            rejectAgentTurn = null;
          });
      });
    }
    runningPhase = "model-completion";
    updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
      ...current,
      phase: "model-completion",
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      runnerPid: process.pid,
    }));
    reviewRun = await executeReview(
      ctx,
      settings,
      {
        id: job.id,
        kind: snapshot.kind,
        repoRoot: snapshot.repoRoot,
        branch: snapshot.branch,
        targetLabel: snapshot.targetLabel,
        targetMode: snapshot.targetMode,
        targetBaseRef: snapshot.targetBaseRef,
        reviewInput: snapshot.reviewInput,
        modelSpec: snapshot.modelSpec,
        thinkingLevel: snapshot.thinkingLevel,
        focusText: snapshot.focusText,
      },
      { persist: true, signal: abortController.signal, inspectionNotes },
    );

    const current = readBackgroundJob(ctx.cwd, job.id);
    if (current?.status === "cancelled" || current?.status === "cancelling" || cancellationRequested) {
      return markCancelled(job.workspaceRoot, job.id, "Background review cancelled before persisting a result.");
    }

    const completedAt = nowIso();
    const markdown = renderStoredReviewMarkdown(reviewRun, {
      backgroundTiming: {
        createdAt: current?.createdAt ?? job.createdAt,
        startedAt: current?.startedAt ?? reviewRun.startedAt,
        completedAt,
        status: "completed",
      },
      backgroundTooling: current?.safeBuiltinTools
        ? {
            safeBuiltinTools: current.safeBuiltinTools ?? [],
            activeWebTools: current.activeWebTools ?? [],
            activeToolNames: current.activeToolNames ?? [],
            missingToolNames: current.missingToolNames ?? [],
          }
        : undefined,
    });
    writeReviewJobResult(job.workspaceRoot, job.id, { reviewRun }, markdown);
    const completed = updateBackgroundJob(job.workspaceRoot, job.id, (current) => {
      if (current.status === "cancelled" || current.status === "cancelling") {
        return {
          ...current,
          updatedAt: completedAt,
          runnerPid: null,
        };
      }
      return {
        ...current,
        status: "completed",
        phase: "done",
        updatedAt: completedAt,
        completedAt,
        runnerPid: null,
        resultVerdict: reviewRun.result?.verdict,
        errorMessage: undefined,
      };
    }) as ReviewBackgroundJob;
    appendJobLog(job.workspaceRoot, job.id, `Background review completed with verdict ${reviewRun.result?.verdict ?? "parse-error"}.`);
    return completed;
  } catch (error) {
    const current = readBackgroundJob(ctx.cwd, job.id);
    if ((current?.status === "cancelled" || current?.status === "cancelling" || cancellationRequested) && !timeoutRequested) {
      return markCancelled(job.workspaceRoot, job.id, "Background review cancelled.");
    }

    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const failed = updateBackgroundJob(job.workspaceRoot, job.id, (existing) => ({
      ...existing,
      status: "failed",
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      runnerPid: null,
      errorMessage: message,
    })) as ReviewBackgroundJob;
    appendJobLog(job.workspaceRoot, job.id, `Background review failed: ${message}`);
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
  }
}

export function internalReviewJobCommandName(): string {
  return INTERNAL_REVIEW_JOB_COMMAND;
}
