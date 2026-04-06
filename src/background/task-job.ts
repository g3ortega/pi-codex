import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { CodexSettings } from "../config/codex-settings.js";
import { getCurrentBranch, getRepoRoot } from "../review/git-context.js";
import { requireModelAuth, resolveModel } from "../review/review-runner.js";
import {
  appendJobLog,
  createTaskBackgroundJob,
  generateJobId,
  getJobLogFile,
  getJobPatchFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  readBackgroundJob,
  readTaskSnapshot,
  updateBackgroundJob,
  writeTaskJobResult,
} from "../runtime/job-store.js";
import { resolveSessionIdentity } from "../runtime/session-identity.js";
import {
  buildBackgroundReadOnlyToolPlan,
  buildBackgroundWriteToolPlan,
  buildTaskPrompt,
  inspectResearchToolsFromNames,
  summarizeResearchRequest,
} from "../runtime/session-prompts.js";
import {
  captureTaskWorktreeDiff,
  cleanupTaskWorktree,
  createTaskWorktree,
  type TaskWorktreeDiff,
  type TaskWorktreeSetup,
} from "../runtime/worktree.js";
import { renderStoredTaskMarkdown } from "../task/task-render.js";
import type {
  CodexTaskExecutionProfile,
  TaskBackgroundJob,
  TaskJobResultPayload,
  TaskSnapshot,
} from "../runtime/job-types.js";

const INTERNAL_TASK_JOB_COMMAND = "codex:internal-run-task-job";
const CURRENT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/core/index.ts", import.meta.url));
const MAX_TASK_JOB_DURATION_MS = 10 * 60 * 1_000;
const WORKSPACE_ROOT_ENV = "PI_CODEX_WORKSPACE_ROOT";

type AgentMessageLike = {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | string;
  errorMessage?: string;
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

function resolveJobWorkspaceRoot(cwd: string): string {
  return process.env[WORKSPACE_ROOT_ENV]?.trim() || cwd;
}

function spawnDetachedTaskWorker(job: TaskBackgroundJob): number | null {
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
      `/${INTERNAL_TASK_JOB_COMMAND} ${job.id}`,
    ];

    const child = spawn(process.execPath, args, {
      cwd: job.executionCwd,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, [WORKSPACE_ROOT_ENV]: job.workspaceRoot },
      windowsHide: true,
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function buildTaskJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  request: string,
  profile: CodexTaskExecutionProfile,
  explicitModel?: string,
): { job: TaskBackgroundJob; snapshot: TaskSnapshot } {
  const sessionIdentity = resolveSessionIdentity(ctx);
  const repoRoot = safeRepoRoot(ctx.cwd);
  const branch = safeBranch(repoRoot);
  const model = resolveModel(ctx, settings, explicitModel);
  const toolPlan = profile === "readonly" ? buildBackgroundReadOnlyToolPlan(pi) : buildBackgroundWriteToolPlan(pi);
  const id = generateJobId("task");
  const createdAt = nowIso();
  const sessionDir = getJobSessionDir(repoRoot, id);
  const thinkingLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
  const worktree = profile === "write" ? createTaskWorktree(ctx.cwd, id) : null;

  const snapshot: TaskSnapshot = {
    kind: "task",
    profile,
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

  const job: TaskBackgroundJob = {
    id,
    jobClass: "task",
    kind: "task",
    profile,
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
    executionCwd: worktree?.agentCwd ?? repoRoot,
    createdAt,
    updatedAt: createdAt,
    status: "queued",
    phase: "queued",
    snapshotFile: getJobSnapshotFile(repoRoot, id),
    resultFile: getJobResultFile(repoRoot, id),
    resultJsonFile: getJobResultJsonFile(repoRoot, id),
    logFile: getJobLogFile(repoRoot, id),
    ...(worktree
      ? {
          worktreePath: worktree.worktreePath,
          worktreeBranch: worktree.branch,
          worktreeBaseCommit: worktree.baseCommit,
          syntheticPaths: worktree.syntheticPaths,
        }
      : {}),
  };

  return { job, snapshot };
}

async function launchBackgroundTaskJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  request: string,
  profile: CodexTaskExecutionProfile,
  explicitModel?: string,
): Promise<TaskBackgroundJob> {
  const model = resolveModel(ctx, settings, explicitModel);
  await requireModelAuth(ctx, model);
  const { job, snapshot } = buildTaskJob(pi, ctx, settings, request, profile, explicitModel);
  createTaskBackgroundJob(job, snapshot);
  appendJobLog(job.workspaceRoot, job.id, `Queued background ${profile} task job.`);

  const runnerPid = spawnDetachedTaskWorker(job);
  const launchedAt = nowIso();
  const launched = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    runnerPid,
    status: "starting",
    phase: "starting",
    updatedAt: launchedAt,
  })) as TaskBackgroundJob;

  appendJobLog(
    launched.workspaceRoot,
    launched.id,
    runnerPid ? `Spawned background ${profile} worker pid ${runnerPid}.` : `Spawned background ${profile} worker.`,
  );
  return launched;
}

export async function launchBackgroundReadonlyTaskJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  request: string,
  explicitModel?: string,
): Promise<TaskBackgroundJob> {
  return launchBackgroundTaskJob(pi, ctx, settings, request, "readonly", explicitModel);
}

export async function launchBackgroundWriteTaskJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  request: string,
  explicitModel?: string,
): Promise<TaskBackgroundJob> {
  return launchBackgroundTaskJob(pi, ctx, settings, request, "write", explicitModel);
}

function markCancelled(
  workspaceRoot: string,
  jobId: string,
  reason: string,
  artifactFields: Partial<TaskBackgroundJob> = {},
): TaskBackgroundJob {
  const cancelledAt = nowIso();
  const next = updateBackgroundJob(workspaceRoot, jobId, (current) => ({
    ...(current as TaskBackgroundJob),
    ...artifactFields,
    status: "cancelled",
    phase: "cancelled",
    updatedAt: cancelledAt,
    cancelledAt: (current as TaskBackgroundJob).cancelledAt ?? cancelledAt,
    runnerPid: null,
    errorMessage: undefined,
  })) as TaskBackgroundJob;
  appendJobLog(workspaceRoot, jobId, reason);
  return next;
}

function buildWorktreeSetup(job: TaskBackgroundJob): TaskWorktreeSetup | null {
  if (job.profile !== "write" || !job.worktreePath || !job.worktreeBranch || !job.worktreeBaseCommit) {
    return null;
  }

  return {
    repoRoot: job.repoRoot,
    baseCommit: job.worktreeBaseCommit,
    branch: job.worktreeBranch,
    worktreePath: job.worktreePath,
    agentCwd: job.executionCwd,
    syntheticPaths: job.syntheticPaths ?? [],
  };
}

function captureWriteArtifacts(job: TaskBackgroundJob): Partial<TaskBackgroundJob> {
  const setup = buildWorktreeSetup(job);
  if (!setup) {
    return {};
  }

  try {
    const diff = captureTaskWorktreeDiff(setup, getJobPatchFile(job.workspaceRoot, job.id));
    return {
      patchFile: diff.patchFile,
      diffStat: diff.diffStat,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
    };
  } catch (error) {
    appendJobLog(job.workspaceRoot, job.id, `Failed to capture worktree diff artifact: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function cleanupWriteWorktree(job: TaskBackgroundJob): void {
  const setup = buildWorktreeSetup(job);
  if (!setup) {
    return;
  }
  cleanupTaskWorktree(setup);
}

export async function runDetachedTaskJob(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  _settings: CodexSettings,
  jobId: string,
): Promise<TaskBackgroundJob> {
  const workspaceRoot = resolveJobWorkspaceRoot(ctx.cwd);
  const baseJob = readBackgroundJob(workspaceRoot, jobId);
  if (!baseJob || baseJob.jobClass !== "task") {
    throw new Error(`Unknown background task job "${jobId}".`);
  }

  const snapshot = readTaskSnapshot(baseJob.workspaceRoot, baseJob.id);
  if (!snapshot) {
    throw new Error(`Missing task snapshot for "${baseJob.id}".`);
  }

  const cancelledBeforeStart = readBackgroundJob(workspaceRoot, baseJob.id);
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
  })) as TaskBackgroundJob;

  appendJobLog(job.workspaceRoot, job.id, `Background ${snapshot.profile} task execution started.`);

  let cancellationRequested = false;
  let rejectCompletion: ((error: Error) => void) | null = null;
  let capturedArtifacts: Partial<TaskBackgroundJob> | null = null;

  const signalHandler = (signal: NodeJS.Signals) => {
    cancellationRequested = true;
    rejectCompletion?.(new Error(`Background task cancelled by ${signal}.`));
    try {
      ctx.abort();
    } catch {
      // Best effort only.
    }
    try {
      markCancelled(job.workspaceRoot, job.id, `Runner received ${signal}; marking job cancelled.`, capturedArtifacts ?? {});
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
            rejectCompletion?.(new Error("Background task cancellation requested."));
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
          phase: "agent-turn",
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

  const maybeCaptureWriteArtifacts = () => {
    if (capturedArtifacts || snapshot.profile !== "write") {
      return capturedArtifacts ?? {};
    }
    capturedArtifacts = captureWriteArtifacts(job);
    return capturedArtifacts;
  };

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
    })) as TaskBackgroundJob;

    appendJobLog(job.workspaceRoot, job.id, `Activated tools: ${activeToolNames.join(", ") || "none"}.`);
    if (missingToolNames.length > 0) {
      appendJobLog(job.workspaceRoot, job.id, `Missing requested tools: ${missingToolNames.join(", ")}.`);
    }

    const effectiveSnapshot = inspectResearchToolsFromNames(pi, activeToolNames);
    const prompt = buildTaskPrompt(snapshot.request, activeToolNames, {
      readOnly: snapshot.profile === "readonly",
      backgroundWrite: snapshot.profile === "write",
      activeWebTools: effectiveSnapshot.activeWebTools,
    });

    let awaitingAgentEnd = false;
    const completion = new Promise<string>((resolve, reject) => {
      let settled = false;
      let matchedAgentStart = false;
      let timeout: NodeJS.Timeout | null = null;
      const settle = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
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
      timeout = setTimeout(() => {
        rejectCompletion?.(
          new Error(`Background task exceeded ${Math.round(MAX_TASK_JOB_DURATION_MS / 1_000)}s without reaching a terminal assistant response.`),
        );
      }, MAX_TASK_JOB_DURATION_MS);
      timeout.unref();

      pi.on("before_agent_start", (event) => {
        if (settled || matchedAgentStart) {
          return;
        }
        if (event.prompt !== prompt) {
          return;
        }
        matchedAgentStart = true;
        appendJobLog(job.workspaceRoot, job.id, "Observed matching background task agent start.");
      });

      pi.on("agent_end", async (event) => {
        if (!awaitingAgentEnd) {
          return;
        }

        const text = extractAssistantText(event.messages as AgentMessageLike[] | undefined);
        if (text) {
          if (!matchedAgentStart) {
            appendJobLog(job.workspaceRoot, job.id, "Accepted agent_end fallback without matching before_agent_start.");
          }
          resolveOnce(text);
          return;
        }
        if (cancellationRequested) {
          rejectCompletion?.(new Error("Background task cancelled."));
          return;
        }
        rejectCompletion?.(new Error("Background task finished without a textual assistant result."));
      });
    });

    appendJobLog(job.workspaceRoot, job.id, `Dispatching background ${snapshot.profile} task prompt.`);
    awaitingAgentEnd = true;
    pi.sendUserMessage(prompt);
    const finalText = await completion;

    const current = readBackgroundJob(workspaceRoot, job.id);
    if (cancellationRequested || current?.status === "cancelled" || current?.status === "cancelling") {
      return markCancelled(job.workspaceRoot, job.id, "Background task cancelled before completion.", maybeCaptureWriteArtifacts());
    }

    const artifactFields = maybeCaptureWriteArtifacts();
    const resultPayload: TaskJobResultPayload = {
      request: snapshot.request,
      profile: snapshot.profile,
      finalText,
      activeToolNames,
      missingToolNames,
      ...(artifactFields.patchFile
        ? {
            patchFile: artifactFields.patchFile,
            diffStat: artifactFields.diffStat,
            filesChanged: artifactFields.filesChanged,
            insertions: artifactFields.insertions,
            deletions: artifactFields.deletions,
          }
        : {}),
    };
    const completedAt = nowIso();
    const completedJob = {
      ...job,
      ...artifactFields,
      status: "completed" as const,
      phase: "completed",
      updatedAt: completedAt,
      completedAt,
      lastHeartbeatAt: completedAt,
      runnerPid: null,
      activeToolNames,
      missingToolNames,
    };
    const markdown = renderStoredTaskMarkdown(completedJob, resultPayload);
    const latestJob = readBackgroundJob(workspaceRoot, job.id);
    if (latestJob?.status === "cancelled" || latestJob?.status === "cancelling" || cancellationRequested) {
      return markCancelled(job.workspaceRoot, job.id, "Background task cancelled before persisting a result.", artifactFields);
    }

    writeTaskJobResult(job.workspaceRoot, job.id, resultPayload, markdown);
    job = updateBackgroundJob(job.workspaceRoot, job.id, () => ({ ...completedJob })) as TaskBackgroundJob;

    appendJobLog(job.workspaceRoot, job.id, `Background ${snapshot.profile} task completed successfully.`);
    return job;
  } catch (error) {
    const artifactFields = maybeCaptureWriteArtifacts();
    const current = readBackgroundJob(workspaceRoot, job.id);
    if (cancellationRequested || current?.status === "cancelled" || current?.status === "cancelling") {
      return markCancelled(job.workspaceRoot, job.id, "Background task cancelled.", artifactFields);
    }

    const message = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    const failed = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
      ...(current as TaskBackgroundJob),
      ...artifactFields,
      status: "failed",
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      runnerPid: null,
      errorMessage: message,
    })) as TaskBackgroundJob;
    appendJobLog(job.workspaceRoot, job.id, `Background task failed: ${message}`);
    throw error instanceof Error ? error : new Error(String(message));
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    if (snapshot.profile === "write") {
      cleanupWriteWorktree(job);
    }
  }
}

export function internalTaskJobCommandName(): string {
  return INTERNAL_TASK_JOB_COMMAND;
}
