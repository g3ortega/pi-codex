import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  backgroundJobSubject,
  type CodexBackgroundJob,
  type JobStatusSnapshot,
  type ResearchBackgroundJob,
  type ResearchJobResultPayload,
  type ResearchSnapshot,
  type ReviewBackgroundJob,
  type ReviewJobResultPayload,
  type ReviewSnapshot,
  type TaskBackgroundJob,
  type TaskJobResultPayload,
  type TaskSnapshot,
  isTerminalJobStatus,
  isReviewBackgroundJob,
} from "./job-types.js";
import { isProcessAlive, terminateProcess } from "./process-tree.js";
import { getWorkspaceJobsDirForRoot, getWorkspaceRoot } from "./state-paths.js";

const LOST_JOB_GRACE_MS = 3_000;
const JOB_LOCK_WAIT_MS = 2_000;
const JOB_LOCK_STALE_MS = 15_000;

function ensurePrivateDir(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best effort only.
  }

  return dirPath;
}

function writePrivateJson(filePath: string, value: unknown): void {
  writePrivateText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sleepSync(milliseconds: number): void {
  const duration = Math.max(1, Math.trunc(milliseconds));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function writeAtomicTextFile(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Best effort only.
  }
  renameSync(tempPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
}

function writePrivateText(filePath: string, content: string): void {
  writeAtomicTextFile(filePath, content);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
}

function jobLockDir(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), ".lock");
}

function acquireJobLock(workspaceRoot: string, jobId: string): void {
  const lockDir = jobLockDir(workspaceRoot, jobId);
  const deadline = Date.now() + JOB_LOCK_WAIT_MS;

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
      if (code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = statSync(lockDir);
        if (Date.now() - stats.mtimeMs > JOB_LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring job lock for "${jobId}".`);
      }
      sleepSync(25);
    }
  }
}

function releaseJobLock(workspaceRoot: string, jobId: string): void {
  try {
    rmSync(jobLockDir(workspaceRoot, jobId), { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}

function withJobLock<T>(workspaceRoot: string, jobId: string, action: () => T): T {
  acquireJobLock(workspaceRoot, jobId);
  try {
    return action();
  } finally {
    releaseJobLock(workspaceRoot, jobId);
  }
}

export function generateJobId(prefix = "job"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function getJobDir(workspaceRoot: string, jobId: string): string {
  return ensurePrivateDir(join(getWorkspaceJobsDirForRoot(workspaceRoot), jobId));
}

export function getJobFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "job.json");
}

export function getJobStatusFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "status.json");
}

export function getJobSnapshotFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "snapshot.json");
}

export function getJobResultFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "result.md");
}

export function getJobResultJsonFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "result.json");
}

export function getJobPatchFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "patch.diff");
}

export function getJobLogFile(workspaceRoot: string, jobId: string): string {
  return join(getJobDir(workspaceRoot, jobId), "run.log");
}

export function getJobSessionDir(workspaceRoot: string, jobId: string): string {
  return ensurePrivateDir(join(getJobDir(workspaceRoot, jobId), "session"));
}

function buildStatusSnapshot(job: CodexBackgroundJob): JobStatusSnapshot {
  return {
    id: job.id,
    jobClass: job.jobClass,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    repoRoot: job.repoRoot,
    branch: job.branch,
    subject: backgroundJobSubject(job),
    resultVerdict: isReviewBackgroundJob(job) ? job.resultVerdict : undefined,
    runnerPid: job.runnerPid,
    errorMessage: job.errorMessage,
  };
}

function writeJobArtifacts(job: CodexBackgroundJob): void {
  ensurePrivateDir(getJobDir(job.workspaceRoot, job.id));
  writePrivateJson(getJobFile(job.workspaceRoot, job.id), job);
  writePrivateJson(getJobStatusFile(job.workspaceRoot, job.id), buildStatusSnapshot(job));
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeReviewSnapshot(workspaceRoot: string, jobId: string, snapshot: ReviewSnapshot): string {
  const filePath = getJobSnapshotFile(workspaceRoot, jobId);
  writePrivateJson(filePath, snapshot);
  return filePath;
}

export function readReviewSnapshot(workspaceRoot: string, jobId: string): ReviewSnapshot | null {
  return readJsonFile<ReviewSnapshot>(getJobSnapshotFile(workspaceRoot, jobId));
}

export function writeResearchSnapshot(workspaceRoot: string, jobId: string, snapshot: ResearchSnapshot): string {
  const filePath = getJobSnapshotFile(workspaceRoot, jobId);
  writePrivateJson(filePath, snapshot);
  return filePath;
}

export function readResearchSnapshot(workspaceRoot: string, jobId: string): ResearchSnapshot | null {
  return readJsonFile<ResearchSnapshot>(getJobSnapshotFile(workspaceRoot, jobId));
}

export function writeTaskSnapshot(workspaceRoot: string, jobId: string, snapshot: TaskSnapshot): string {
  const filePath = getJobSnapshotFile(workspaceRoot, jobId);
  writePrivateJson(filePath, snapshot);
  return filePath;
}

export function readTaskSnapshot(workspaceRoot: string, jobId: string): TaskSnapshot | null {
  return readJsonFile<TaskSnapshot>(getJobSnapshotFile(workspaceRoot, jobId));
}

export function writeReviewJobResult(workspaceRoot: string, jobId: string, result: ReviewJobResultPayload, markdown: string): void {
  writePrivateJson(getJobResultJsonFile(workspaceRoot, jobId), result);
  writePrivateText(getJobResultFile(workspaceRoot, jobId), markdown);
}

export function writeResearchJobResult(workspaceRoot: string, jobId: string, result: ResearchJobResultPayload, markdown: string): void {
  writePrivateJson(getJobResultJsonFile(workspaceRoot, jobId), result);
  writePrivateText(getJobResultFile(workspaceRoot, jobId), markdown);
}

export function writeTaskJobResult(workspaceRoot: string, jobId: string, result: TaskJobResultPayload, markdown: string): void {
  writePrivateJson(getJobResultJsonFile(workspaceRoot, jobId), result);
  writePrivateText(getJobResultFile(workspaceRoot, jobId), markdown);
}

export function readBackgroundJobResultMarkdown(workspaceRoot: string, jobId: string): string | null {
  const resultFile = getJobResultFile(workspaceRoot, jobId);
  if (!existsSync(resultFile)) {
    return null;
  }

  try {
    return readFileSync(resultFile, "utf8");
  } catch {
    return null;
  }
}

export function readReviewJobResult(workspaceRoot: string, jobId: string): ReviewJobResultPayload | null {
  return readJsonFile<ReviewJobResultPayload>(getJobResultJsonFile(workspaceRoot, jobId));
}

export function readResearchJobResult(workspaceRoot: string, jobId: string): ResearchJobResultPayload | null {
  return readJsonFile<ResearchJobResultPayload>(getJobResultJsonFile(workspaceRoot, jobId));
}

export function readTaskJobResult(workspaceRoot: string, jobId: string): TaskJobResultPayload | null {
  return readJsonFile<TaskJobResultPayload>(getJobResultJsonFile(workspaceRoot, jobId));
}

export function appendJobLog(workspaceRoot: string, jobId: string, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  withJobLock(workspaceRoot, jobId, () => {
    const logFile = getJobLogFile(workspaceRoot, jobId);
    const existing = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    writePrivateText(logFile, `${existing}[${new Date().toISOString()}] ${trimmed}\n`);
  });
}

export function createReviewBackgroundJob(job: ReviewBackgroundJob, snapshot: ReviewSnapshot): ReviewBackgroundJob {
  withJobLock(job.workspaceRoot, job.id, () => {
    writeReviewSnapshot(job.workspaceRoot, job.id, snapshot);
    writePrivateText(job.logFile, "");
    writeJobArtifacts(job);
  });
  return job;
}

export function createResearchBackgroundJob(job: ResearchBackgroundJob, snapshot: ResearchSnapshot): ResearchBackgroundJob {
  withJobLock(job.workspaceRoot, job.id, () => {
    writeResearchSnapshot(job.workspaceRoot, job.id, snapshot);
    writePrivateText(job.logFile, "");
    writeJobArtifacts(job);
  });
  return job;
}

export function createTaskBackgroundJob(job: TaskBackgroundJob, snapshot: TaskSnapshot): TaskBackgroundJob {
  withJobLock(job.workspaceRoot, job.id, () => {
    writeTaskSnapshot(job.workspaceRoot, job.id, snapshot);
    writePrivateText(job.logFile, "");
    writeJobArtifacts(job);
  });
  return job;
}

export function readBackgroundJobById(workspaceRoot: string, jobId: string): CodexBackgroundJob | null {
  return readJsonFile<CodexBackgroundJob>(getJobFile(workspaceRoot, jobId));
}

function maybeMarkLost(job: CodexBackgroundJob): CodexBackgroundJob {
  if (isTerminalJobStatus(job.status)) {
    return job;
  }
  if (isProcessAlive(job.runnerPid)) {
    return job;
  }

  const pivot = job.lastHeartbeatAt ?? job.updatedAt ?? job.createdAt;
  const elapsed = Date.now() - Date.parse(pivot);
  if (!Number.isFinite(elapsed) || elapsed < LOST_JOB_GRACE_MS) {
    return job;
  }

  if (job.status === "cancelling") {
    const cancelledAt = new Date().toISOString();
    const cancelledJob: CodexBackgroundJob = {
      ...job,
      status: "cancelled",
      phase: "cancelled",
      updatedAt: cancelledAt,
      cancelledAt: job.cancelledAt ?? cancelledAt,
      errorMessage: undefined,
      runnerPid: null,
    };
    writeJobArtifacts(cancelledJob);
    appendJobLog(cancelledJob.workspaceRoot, cancelledJob.id, "Job marked cancelled after runner process disappeared.");
    return cancelledJob;
  }

  const lostJob: CodexBackgroundJob = {
    ...job,
    status: "lost",
    phase: "lost",
    updatedAt: new Date().toISOString(),
    errorMessage: job.errorMessage ?? "Background job process disappeared before reporting a terminal state.",
    runnerPid: null,
  };
  writeJobArtifacts(lostJob);
  appendJobLog(lostJob.workspaceRoot, lostJob.id, "Job marked lost after runner process disappeared.");
  return lostJob;
}

export function readBackgroundJob(cwd: string, jobId: string): CodexBackgroundJob | null {
  const workspaceRoot = getWorkspaceRoot(cwd);
  const job = readBackgroundJobById(workspaceRoot, jobId);
  if (!job) {
    return null;
  }
  return maybeMarkLost(job);
}

function listJobIds(workspaceRoot: string): string[] {
  const jobsDir = getWorkspaceJobsDirForRoot(workspaceRoot);
  return readdirSync(jobsDir).filter((entry) => existsSync(join(jobsDir, entry, "job.json")));
}

export function listBackgroundJobs(cwd: string): CodexBackgroundJob[] {
  const workspaceRoot = getWorkspaceRoot(cwd);
  return listJobIds(workspaceRoot)
    .map((jobId) => readBackgroundJobById(workspaceRoot, jobId))
    .filter((job): job is CodexBackgroundJob => job !== null)
    .map((job) => maybeMarkLost(job))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findBackgroundJob(
  cwd: string,
  reference?: string,
  options: { preferActive?: boolean; activeOnly?: boolean } = {},
): CodexBackgroundJob | null {
  const jobs = listBackgroundJobs(cwd);
  const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
  const preferred = options.activeOnly ? activeJobs : options.preferActive ? activeJobs : jobs;

  const match = (pool: CodexBackgroundJob[]): CodexBackgroundJob | null => {
    if (!reference) {
      return pool[0] ?? null;
    }

    const exact = pool.find((job) => job.id === reference);
    if (exact) {
      return exact;
    }

    const prefixMatches = pool.filter((job) => job.id.startsWith(reference));
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
    if (prefixMatches.length > 1) {
      throw new Error(`Job reference "${reference}" is ambiguous. Use a longer id.`);
    }

    return null;
  };

  const preferredMatch = match(preferred);
  if (preferredMatch || options.activeOnly || !options.preferActive) {
    return preferredMatch;
  }

  return match(jobs);
}

export function updateBackgroundJob(
  workspaceRoot: string,
  jobId: string,
  updater: (current: CodexBackgroundJob) => CodexBackgroundJob,
): CodexBackgroundJob {
  return withJobLock(workspaceRoot, jobId, () => {
    const current = readBackgroundJobById(workspaceRoot, jobId);
    if (!current) {
      throw new Error(`Unknown background job "${jobId}".`);
    }

    const next = updater(current);
    const normalized = isTerminalJobStatus(current.status) ? current : next;
    writeJobArtifacts(normalized);
    return normalized;
  });
}

export function cancelBackgroundJob(cwd: string, reference?: string): CodexBackgroundJob | null {
  const job = findBackgroundJob(cwd, reference, { activeOnly: true });
  if (!job) {
    return null;
  }

  const requestedAt = new Date().toISOString();
  const cancelling = updateBackgroundJob(job.workspaceRoot, job.id, (current) => ({
    ...current,
    status: "cancelling",
    phase: "cancelling",
    updatedAt: requestedAt,
  }));
  const signalled = terminateProcess(job.runnerPid);
  appendJobLog(
    cancelling.workspaceRoot,
    cancelling.id,
    signalled
      ? "Cancellation requested; stop signal sent to background runner."
      : "Cancellation requested; awaiting worker acknowledgement.",
  );
  return cancelling;
}

export function markBackgroundJobNotified(workspaceRoot: string, jobId: string, sessionId?: string): CodexBackgroundJob {
  return withJobLock(workspaceRoot, jobId, () => {
    const current = readBackgroundJobById(workspaceRoot, jobId);
    if (!current) {
      throw new Error(`Unknown background job "${jobId}".`);
    }

    if (current.notificationDeliveredAt) {
      return current;
    }

    const deliveredAt = new Date().toISOString();
    const next = {
      ...current,
      notificationDeliveredAt: deliveredAt,
      notifiedSessionId: sessionId ?? current.notifiedSessionId,
      updatedAt: current.updatedAt,
    };
    writeJobArtifacts(next);
    return next;
  });
}
