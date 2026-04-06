import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { CodexSettings } from "../config/codex-settings.js";
import {
  appendJobLog,
  createReviewBackgroundJob,
  generateJobId,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSnapshotFile,
  readBackgroundJob,
  readReviewSnapshot,
  updateBackgroundJob,
  writeReviewJobResult,
} from "../runtime/job-store.js";
import type { ReviewBackgroundJob, ReviewSnapshot } from "../runtime/job-types.js";
import { resolveSessionIdentity } from "../runtime/session-identity.js";
import { collectReviewContext, resolveReviewTarget } from "../review/git-context.js";
import { renderStoredReviewMarkdown } from "../review/review-render.js";
import {
  executePreparedReviewRun,
  requireModelAuth,
  resolveModel,
  type ReviewCommandOptions,
} from "../review/review-runner.js";
import { resolveEffectiveThinkingLevel } from "../runtime/thinking.js";
import { reviewKindIdPrefix, type CodexReviewKind } from "../review/review-kind.js";

const INTERNAL_REVIEW_JOB_COMMAND = "codex:internal-run-review-job";
const CURRENT_EXTENSION_PATH = fileURLToPath(new URL("../../extensions/core/index.ts", import.meta.url));
const MAX_REVIEW_JOB_DURATION_MS = 5 * 60 * 1_000;
const MAX_MENTAL_MODELS_REVIEW_JOB_DURATION_MS = 12 * 60 * 1_000;

type ReviewJobRuntime = {
  executeReview?: typeof executePreparedReviewRun;
  timeoutMs?: number;
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

function spawnDetachedReviewWorker(job: ReviewBackgroundJob): number | null {
  const stdout = openSync(job.logFile, "a", 0o600);
  const stderr = openSync(job.logFile, "a", 0o600);
  try {
    const args = [
      cliEntryPoint(),
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--extension",
      CURRENT_EXTENSION_PATH,
      "--model",
      job.modelSpec,
      ...(job.thinkingLevel ? ["--thinking", job.thinkingLevel] : []),
      "-p",
      `/${INTERNAL_REVIEW_JOB_COMMAND} ${job.id}`,
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

export async function launchBackgroundReviewJob(
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
  const thinkingLevel = resolveEffectiveThinkingLevel(model, options.thinkingLevel);
  const id = generateJobId(reviewKindIdPrefix(kind));
  const createdAt = nowIso();

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

export async function runDetachedReviewJob(
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
  let cancellationRequested = false;
  let timeoutRequested = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const signalHandler = (signal: NodeJS.Signals) => {
    cancellationRequested = true;
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
          phase: "model-completion",
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
    phase: "model-completion",
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
    abortController.abort(new Error(message));
  }, timeoutMs);
  timeoutHandle.unref();

  try {
    const reviewRun = await executeReview(
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
      { persist: true, signal: abortController.signal },
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
