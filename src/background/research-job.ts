import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { CodexSettings } from "../config/codex-settings.js";
import { createSessionActivityWatchdog } from "./session-activity.js";
import { renderStoredResearchMarkdown } from "../research/research-render.js";
import { getCurrentBranch, getRepoRoot } from "../review/git-context.js";
import { requireModelAuth, resolveModel } from "../review/review-runner.js";
import {
  appendJobLog,
  createResearchBackgroundJob,
  generateJobId,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  readBackgroundJob,
  readResearchSnapshot,
  updateBackgroundJob,
  writeResearchJobResult,
} from "../runtime/job-store.js";
import type { ResearchBackgroundJob, ResearchSnapshot } from "../runtime/job-types.js";
import {
  buildBackgroundResearchToolPlan,
  buildResearchPrompt,
  inspectResearchToolsFromNames,
  summarizeResearchRequest,
} from "../runtime/session-prompts.js";
import { resolveSessionIdentity } from "../runtime/session-identity.js";
import { resolveEffectiveThinkingLevel, type CodexThinkingLevel } from "../runtime/thinking.js";

const INTERNAL_RESEARCH_JOB_COMMAND = "codex:internal-run-research-job";
const CURRENT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/core/index.ts", import.meta.url));
const MAX_RESEARCH_JOB_DURATION_MS = 15 * 60 * 1_000;
const MAX_RESEARCH_JOB_IDLE_MS = 3 * 60 * 1_000;

type AgentMessageLike = {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  errorMessage?: string;
};

type AgentMessageEntryLike = AgentMessageLike;

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

function safeRepoRoot(cwd: string): string {
  try {
    return getRepoRoot(cwd);
  } catch {
    return cwd;
  }
}

function safeBranch(cwd: string): string {
  try {
    return getCurrentBranch(cwd);
  } catch {
    return "HEAD";
  }
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

function extractAssistantTextFromMessage(message: AgentMessageEntryLike | undefined): string {
  return extractAssistantText(message ? [message] : undefined);
}

function spawnDetachedResearchWorker(job: ResearchBackgroundJob): number | null {
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
      ...job.extensionPaths.flatMap((extensionPath) => ["--extension", extensionPath]),
      "--tools",
      job.safeBuiltinTools.join(","),
      "--model",
      job.modelSpec,
      ...(job.thinkingLevel ? ["--thinking", job.thinkingLevel] : []),
      "--session-dir",
      job.sessionDir,
      "-p",
      `/${INTERNAL_RESEARCH_JOB_COMMAND} ${job.id}`,
    ];

    const child = spawn(process.execPath, args, {
      cwd: job.repoRoot,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function launchBackgroundResearchJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  request: string,
  explicitModel?: string,
  explicitThinkingLevel?: CodexThinkingLevel,
): Promise<ResearchBackgroundJob> {
  const sessionIdentity = resolveSessionIdentity(ctx);
  const repoRoot = safeRepoRoot(ctx.cwd);
  const branch = safeBranch(repoRoot);
  const toolPlan = buildBackgroundResearchToolPlan(pi);
  const model = resolveModel(ctx, settings, explicitModel);
  await requireModelAuth(ctx, model);
  const id = generateJobId("research");
  const createdAt = nowIso();
  const sessionDir = getJobSessionDir(repoRoot, id);
  const thinkingLevel = resolveEffectiveThinkingLevel(
    model,
    explicitThinkingLevel ?? (typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined),
  );

  const snapshot: ResearchSnapshot = {
    kind: "research",
    repoRoot,
    branch,
    request: request.trim(),
    modelSpec: modelSpec(model.provider, model.id),
    thinkingLevel,
    requestedToolNames: toolPlan.requestedToolNames,
    safeBuiltinTools: toolPlan.safeBuiltinTools,
    activeWebTools: toolPlan.interactiveSnapshot.activeWebTools,
    inactiveAvailableWebTools: toolPlan.interactiveSnapshot.inactiveAvailableWebTools,
    extensionPaths: toolPlan.extensionPaths,
  };

  const job: ResearchBackgroundJob = {
    id,
    jobClass: "research",
    kind: "research",
    workspaceRoot: repoRoot,
    cwd: ctx.cwd,
    repoRoot,
    branch,
    originSessionId: sessionIdentity.id,
    originSessionFile: sessionIdentity.file,
    originCwd: sessionIdentity.cwd,
    request: snapshot.request,
    requestSummary: summarizeResearchRequest(snapshot.request),
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
    snapshotFile: getJobSnapshotFile(repoRoot, id),
    resultFile: getJobResultFile(repoRoot, id),
    resultJsonFile: getJobResultJsonFile(repoRoot, id),
    logFile: getJobLogFile(repoRoot, id),
  };

  createResearchBackgroundJob(job, snapshot);
  appendJobLog(job.workspaceRoot, job.id, "Queued background research job.");

  const runnerPid = spawnDetachedResearchWorker(job);
  const launchedAt = nowIso();
  const launched = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    runnerPid,
    status: "starting",
    phase: "starting",
    updatedAt: launchedAt,
  })) as ResearchBackgroundJob;

  appendJobLog(launched.workspaceRoot, launched.id, runnerPid ? `Spawned background worker pid ${runnerPid}.` : "Spawned background worker.");
  return launched;
}

function markCancelled(workspaceRoot: string, jobId: string, reason: string): ResearchBackgroundJob {
  const cancelledAt = nowIso();
  const next = updateBackgroundJob(workspaceRoot, jobId, (current) => ({
    ...current,
    status: "cancelled",
    phase: "cancelled",
    updatedAt: cancelledAt,
    cancelledAt: current.cancelledAt ?? cancelledAt,
    runnerPid: null,
    errorMessage: undefined,
  })) as ResearchBackgroundJob;
  appendJobLog(workspaceRoot, jobId, reason);
  return next;
}

export async function runDetachedResearchJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  _settings: CodexSettings,
  jobId: string,
): Promise<ResearchBackgroundJob> {
  const baseJob = readBackgroundJob(ctx.cwd, jobId);
  if (!baseJob || baseJob.jobClass !== "research") {
    throw new Error(`Unknown background research job "${jobId}".`);
  }

  const snapshot = readResearchSnapshot(baseJob.workspaceRoot, baseJob.id);
  if (!snapshot) {
    throw new Error(`Missing research snapshot for "${baseJob.id}".`);
  }

  const cancelledBeforeStart = readBackgroundJob(ctx.cwd, baseJob.id);
  if (cancelledBeforeStart?.status === "cancelled" || cancelledBeforeStart?.status === "cancelling") {
    appendJobLog(baseJob.workspaceRoot, baseJob.id, "Job was already cancelled before execution started.");
    return markCancelled(baseJob.workspaceRoot, baseJob.id, "Job was already cancelled before execution started.");
  }

  const startedAt = nowIso();
  let job = updateBackgroundJob(baseJob.workspaceRoot, baseJob.id, (current) => ({
    ...current,
    status: "running",
    phase: "preparing-tools",
    updatedAt: startedAt,
    startedAt: current.startedAt ?? startedAt,
    lastHeartbeatAt: startedAt,
    runnerPid: process.pid,
  })) as ResearchBackgroundJob;

  appendJobLog(job.workspaceRoot, job.id, "Background research execution started.");

  let cancellationRequested = false;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const signalHandler = (signal: NodeJS.Signals) => {
    cancellationRequested = true;
    rejectCompletion?.(new Error(`Background research cancelled by ${signal}.`));
    try {
      ctx.abort();
    } catch {
      // Best effort only.
    }
    try {
      markCancelled(job.workspaceRoot, job.id, `Runner received ${signal}; marking job cancelled.`);
    } catch {
      // Best effort during teardown.
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
            rejectCompletion?.(new Error("Background research cancellation requested."));
            try {
              ctx.abort();
            } catch {
              // Best effort only.
            }
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

  try {
    const availableToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const activeToolNames = snapshot.requestedToolNames.filter((toolName) => availableToolNames.has(toolName));
    const missingToolNames = snapshot.requestedToolNames.filter((toolName) => !availableToolNames.has(toolName));
    pi.setActiveTools(activeToolNames);

    job = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
      ...current,
      phase: "agent-turn",
      updatedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      runnerPid: process.pid,
      activeToolNames,
      missingToolNames,
    })) as ResearchBackgroundJob;

    appendJobLog(job.workspaceRoot, job.id, `Activated tools: ${activeToolNames.join(", ") || "none"}.`);
    if (missingToolNames.length > 0) {
      appendJobLog(job.workspaceRoot, job.id, `Missing requested tools: ${missingToolNames.join(", ")}.`);
    }

    const effectiveSnapshot = inspectResearchToolsFromNames(pi, activeToolNames);
    const prompt = buildResearchPrompt(snapshot.request, effectiveSnapshot);
    let awaitingAgentEnd = false;
    const completion = new Promise<string>((resolve, reject) => {
      let settled = false;
      let matchedAgentStart = false;
      const watchdog = createSessionActivityWatchdog({
        sessionDir: job.sessionDir,
        idleTimeoutMs: MAX_RESEARCH_JOB_IDLE_MS,
        hardTimeoutMs: MAX_RESEARCH_JOB_DURATION_MS,
        onTimeout: (kind) => {
          const message =
            kind === "idle"
              ? `Background research was idle for ${Math.round(MAX_RESEARCH_JOB_IDLE_MS / 1_000)}s without new session activity.`
              : `Background research exceeded ${Math.round(MAX_RESEARCH_JOB_DURATION_MS / 1_000)}s without reaching a terminal assistant response.`;
          rejectCompletion?.(new Error(message));
        },
      });
      const settle = () => {
        watchdog.clear();
        awaitingAgentEnd = false;
        rejectCompletion = null;
      };
      rejectCompletion = (error) => {
        if (settled) {
          return;
        }
        settled = true;
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

      pi.on("before_agent_start", (event) => {
        if (settled || matchedAgentStart) {
          return;
        }
        if (event.prompt !== prompt) {
          return;
        }
        matchedAgentStart = true;
        appendJobLog(job.workspaceRoot, job.id, "Observed matching background research agent start.");
      });

      pi.on("agent_end", async (event) => {
        if (!awaitingAgentEnd) {
          return;
        }

        const text =
          extractAssistantText(event.messages as AgentMessageLike[] | undefined) ||
          extractAssistantTextFromMessage((event.messages as AgentMessageLike[] | undefined)?.at(-1));
        if (text) {
          if (!matchedAgentStart) {
            appendJobLog(job.workspaceRoot, job.id, "Accepted agent_end fallback without matching before_agent_start.");
          }
          resolveOnce(text);
          return;
        }
        if (cancellationRequested) {
          rejectCompletion?.(new Error("Background research cancelled."));
          return;
        }
        rejectCompletion?.(new Error("Background research finished without a textual assistant result."));
      });
    });

    appendJobLog(job.workspaceRoot, job.id, "Dispatching background research prompt.");
    // The detached child is single-use, so the first terminal agent_end after dispatch belongs to this run.
    // before_agent_start is still observed when available, but agent_end fallback keeps the job from timing out
    // if PI skips or reorders that event in print/rpc modes.
    // This is intentionally narrower than trying to correlate across a shared long-lived process.
    //
    // Keep the flag separate from matchedAgentStart so missing pre-start events do not deadlock completion.
    //
    // Ordering matters: arm the handler before dispatching the new user message.
    awaitingAgentEnd = true;
    pi.sendUserMessage(prompt);
    const finalText = await completion;

    const current = readBackgroundJob(ctx.cwd, job.id);
    if (cancellationRequested || current?.status === "cancelled" || current?.status === "cancelling") {
      return markCancelled(job.workspaceRoot, job.id, "Background research cancelled before completion.");
    }

    const resultPayload = {
      request: snapshot.request,
      finalText,
      activeToolNames,
      missingToolNames,
    };
    const completedAt = nowIso();
    const completedJob = {
      ...job,
      status: "completed" as const,
      phase: "completed",
      updatedAt: completedAt,
      completedAt,
      lastHeartbeatAt: completedAt,
      runnerPid: null,
      activeToolNames,
      missingToolNames,
    };
    const markdown = renderStoredResearchMarkdown(completedJob, resultPayload);
    const latestJob = readBackgroundJob(ctx.cwd, job.id);
    if (latestJob?.status === "cancelled" || latestJob?.status === "cancelling" || cancellationRequested) {
      return markCancelled(job.workspaceRoot, job.id, "Background research cancelled before persisting a result.");
    }
    writeResearchJobResult(job.workspaceRoot, job.id, resultPayload, markdown);
    job = updateBackgroundJob(job.workspaceRoot, job.id, () => ({
      ...completedJob,
    })) as ResearchBackgroundJob;

    appendJobLog(job.workspaceRoot, job.id, "Background research completed successfully.");
    return job;
  } catch (error) {
    const current = readBackgroundJob(ctx.cwd, job.id);
    if (cancellationRequested || current?.status === "cancelled" || current?.status === "cancelling") {
      return markCancelled(job.workspaceRoot, job.id, "Background research cancelled.");
    }

    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const failed = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
      ...current,
      status: "failed",
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      runnerPid: null,
      errorMessage: message,
    })) as ResearchBackgroundJob;
    appendJobLog(job.workspaceRoot, job.id, `Background research failed: ${message}`);
    throw error instanceof Error ? error : new Error(String(message));
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
  }
}

export function internalResearchJobCommandName(): string {
  return INTERNAL_RESEARCH_JOB_COMMAND;
}
