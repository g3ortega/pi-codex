import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  markBackgroundJobNotified,
  readBackgroundJob,
  readBackgroundJobResultMarkdown,
  readResearchJobResult,
  readReviewJobResult,
  readTaskJobResult,
} from "../../src/runtime/job-store.js";
import {
  backgroundJobNotificationTitle,
  backgroundJobReportVariant,
  renderBackgroundJobCompletionMarkdown,
} from "../../src/runtime/job-render.js";
import { sendReport } from "../../src/runtime/report-message.js";
import { resolveSessionIdentity } from "../../src/runtime/session-identity.js";
import { getWorkspaceJobsDirForRoot, getWorkspaceRoot } from "../../src/runtime/state-paths.js";
import { isTerminalJobStatus, type CodexBackgroundJob } from "../../src/runtime/job-types.js";

const POLL_INTERVAL_MS = 2_000;
const COALESCE_MS = 75;
const DEDUPE_TTL_MS = 10 * 60 * 1_000;

type NotifyState = {
  currentSessionId: string | null;
  currentSessionFile?: string;
  currentCwd: string;
  workspaceRoot: string;
  jobsDir: string;
  lastUiContext: ExtensionContext | null;
  rootWatcher: FSWatcher | null;
  jobWatchers: Map<string, FSWatcher>;
  pendingJobs: Map<string, ReturnType<typeof setTimeout>>;
  poller: ReturnType<typeof setInterval> | null;
  completionSeen: Map<string, number>;
};

function createState(): NotifyState {
  return {
    currentSessionId: null,
    currentSessionFile: undefined,
    currentCwd: process.cwd(),
    workspaceRoot: getWorkspaceRoot(process.cwd()),
    jobsDir: getWorkspaceJobsDirForRoot(getWorkspaceRoot(process.cwd())),
    lastUiContext: null,
    rootWatcher: null,
    jobWatchers: new Map(),
    pendingJobs: new Map(),
    poller: null,
    completionSeen: new Map(),
  };
}

function pruneSeenMap(seen: Map<string, number>, now: number): void {
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      seen.delete(key);
    }
  }
}

function markSeen(state: NotifyState, key: string): boolean {
  const now = Date.now();
  pruneSeenMap(state.completionSeen, now);
  if (state.completionSeen.has(key)) {
    return true;
  }
  state.completionSeen.set(key, now);
  return false;
}

function listWorkspaceJobIds(jobsDir: string): string[] {
  if (!existsSync(jobsDir)) {
    return [];
  }

  return readdirSync(jobsDir)
    .filter((entry) => existsSync(join(jobsDir, entry, "job.json")));
}

function variantForUi(job: CodexBackgroundJob): "info" | "warning" | "error" {
  const variant = backgroundJobReportVariant(job);
  return variant === "success" ? "info" : variant;
}

function summarizeCompletion(job: CodexBackgroundJob): string | undefined {
  if (job.jobClass === "review" && job.status === "completed") {
    const payload = readReviewJobResult(job.workspaceRoot, job.id);
    return payload?.reviewRun.result?.summary ?? payload?.reviewRun.parseError ?? undefined;
  }

  if (job.jobClass === "research" && job.status === "completed") {
    const payload = readResearchJobResult(job.workspaceRoot, job.id);
    return payload?.finalText;
  }

  if (job.jobClass === "task" && job.status === "completed") {
    const payload = readTaskJobResult(job.workspaceRoot, job.id);
    return payload?.finalText;
  }

  return job.errorMessage;
}

function matchesCurrentSession(job: CodexBackgroundJob, state: NotifyState): boolean {
  if (!state.currentSessionId) {
    return false;
  }

  if (job.originSessionId) {
    return job.originSessionId === state.currentSessionId;
  }
  if (job.originSessionFile && state.currentSessionFile) {
    return job.originSessionFile === state.currentSessionFile;
  }
  if (job.originCwd) {
    return job.originCwd === state.currentCwd;
  }

  return false;
}

function completionKey(job: CodexBackgroundJob, state: NotifyState): string {
  return [
    state.currentSessionId ?? "no-session",
    job.id,
    job.status,
    job.completedAt ?? job.cancelledAt ?? job.updatedAt,
  ].join(":");
}

function syncJobWatchers(state: NotifyState, scheduleJob: (jobId: string) => void): void {
  const knownIds = new Set(listWorkspaceJobIds(state.jobsDir));

  for (const [jobId, watcher] of state.jobWatchers.entries()) {
    if (knownIds.has(jobId)) {
      continue;
    }
    watcher.close();
    state.jobWatchers.delete(jobId);
  }

  for (const jobId of knownIds) {
    if (state.jobWatchers.has(jobId)) {
      continue;
    }

    try {
      const watcher = watch(join(state.jobsDir, jobId), () => {
        scheduleJob(jobId);
      });
      watcher.on("error", () => {
        watcher.close();
        state.jobWatchers.delete(jobId);
      });
      state.jobWatchers.set(jobId, watcher);
    } catch {
      // Poller will still pick the job up even if watch registration fails.
    }
  }
}

function stopWatching(state: NotifyState): void {
  state.rootWatcher?.close();
  state.rootWatcher = null;

  for (const watcher of state.jobWatchers.values()) {
    watcher.close();
  }
  state.jobWatchers.clear();

  for (const timer of state.pendingJobs.values()) {
    clearTimeout(timer);
  }
  state.pendingJobs.clear();

  if (state.poller) {
    clearInterval(state.poller);
    state.poller = null;
  }
}

function notifyCompletion(pi: ExtensionAPI, state: NotifyState, job: CodexBackgroundJob): void {
  const summary = summarizeCompletion(job);
  const fullResultMarkdown = job.status === "completed"
    ? readBackgroundJobResultMarkdown(job.workspaceRoot, job.id) ?? undefined
    : undefined;
  const markdown = renderBackgroundJobCompletionMarkdown(job, summary, fullResultMarkdown);

  if (state.lastUiContext?.hasUI) {
    const label = job.jobClass === "review"
      ? `Codex ${job.kind === "adversarial-review" ? "adversarial review" : "review"} ${job.status}`
      : job.jobClass === "research"
        ? `Codex research ${job.status}`
        : `Codex task ${job.status}`;
    state.lastUiContext.ui.notify(label, variantForUi(job));
  }

  sendReport(
    pi,
    backgroundJobNotificationTitle(job),
    markdown,
    backgroundJobReportVariant(job),
    { triggerTurn: false },
  );

  markBackgroundJobNotified(job.workspaceRoot, job.id, state.currentSessionId ?? undefined);
}

function scheduleWorkspaceScan(state: NotifyState, scheduleJob: (jobId: string) => void): void {
  syncJobWatchers(state, scheduleJob);
  for (const jobId of listWorkspaceJobIds(state.jobsDir)) {
    scheduleJob(jobId);
  }
}

export default function registerCodexNotifyExtension(pi: ExtensionAPI): void {
  const state = createState();

  const processJob = (jobId: string) => {
    const job = readBackgroundJob(state.workspaceRoot, jobId);
    if (!job || !isTerminalJobStatus(job.status)) {
      return;
    }
    if (job.notificationDeliveredAt || !matchesCurrentSession(job, state)) {
      return;
    }

    const key = completionKey(job, state);
    if (markSeen(state, key)) {
      return;
    }

    notifyCompletion(pi, state, job);
  };

  const scheduleJob = (jobId: string) => {
    const existing = state.pendingJobs.get(jobId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      state.pendingJobs.delete(jobId);
      try {
        processJob(jobId);
      } catch {
        // Best effort only. Polling and future fs events can retry if needed.
      }
    }, COALESCE_MS);
    timer.unref?.();
    state.pendingJobs.set(jobId, timer);
  };

  const startWatching = () => {
    stopWatching(state);

    try {
      state.rootWatcher = watch(state.jobsDir, () => {
        scheduleWorkspaceScan(state, scheduleJob);
      });
      state.rootWatcher.on("error", () => {
        state.rootWatcher?.close();
        state.rootWatcher = null;
      });
    } catch {
      state.rootWatcher = null;
    }

    scheduleWorkspaceScan(state, scheduleJob);

    state.poller = setInterval(() => {
      scheduleWorkspaceScan(state, scheduleJob);
    }, POLL_INTERVAL_MS);
    state.poller.unref?.();
  };

  const resetSessionState = (ctx: ExtensionContext) => {
    const identity = resolveSessionIdentity(ctx);
    state.currentSessionId = identity.id;
    state.currentSessionFile = identity.file;
    state.currentCwd = identity.cwd;
    state.workspaceRoot = getWorkspaceRoot(ctx.cwd);
    state.jobsDir = getWorkspaceJobsDirForRoot(state.workspaceRoot);
    state.lastUiContext = ctx;
    startWatching();
  };

  pi.on("session_start", (_event, ctx) => {
    resetSessionState(ctx);
  });

  pi.on("session_shutdown", () => {
    stopWatching(state);
    state.lastUiContext = null;
    state.currentSessionId = null;
    state.currentSessionFile = undefined;
  });
}
