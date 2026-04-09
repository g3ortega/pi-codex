import type { StoredReviewRun, ReviewVerdict } from "../review/review-schema.js";
import type { CodexReviewKind } from "../review/review-kind.js";
import type { CodexThinkingLevel } from "./thinking.js";

export type CodexJobClass = "review" | "research" | "task";
export type CodexReviewJobKind = CodexReviewKind;
export type CodexResearchJobKind = "research";
export type CodexTaskJobKind = "task";
export type CodexTaskExecutionProfile = "readonly" | "write";
export type CodexJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export interface ReviewSnapshot {
  kind: CodexReviewJobKind;
  repoRoot: string;
  branch: string;
  targetLabel: string;
  targetMode: "working-tree" | "branch";
  targetBaseRef?: string;
  focusText?: string;
  modelSpec: string;
  thinkingLevel?: CodexThinkingLevel;
  requestedToolNames?: string[];
  safeBuiltinTools?: string[];
  activeWebTools?: string[];
  inactiveAvailableWebTools?: string[];
  extensionPaths?: string[];
  reviewInput: string;
}

export interface ReviewJobResultPayload {
  reviewRun: StoredReviewRun;
}

export interface ResearchSnapshot {
  kind: CodexResearchJobKind;
  repoRoot: string;
  branch: string;
  request: string;
  modelSpec: string;
  thinkingLevel?: CodexThinkingLevel;
  nativeWebSearchEnabled?: boolean;
  requestedToolNames: string[];
  safeBuiltinTools: string[];
  activeWebTools: string[];
  inactiveAvailableWebTools: string[];
  extensionPaths: string[];
}

export interface ResearchJobResultPayload {
  request: string;
  finalText: string;
  activeToolNames: string[];
  missingToolNames: string[];
}

export interface TaskSnapshot {
  kind: CodexTaskJobKind;
  profile: CodexTaskExecutionProfile;
  repoRoot: string;
  branch: string;
  request: string;
  modelSpec: string;
  thinkingLevel?: CodexThinkingLevel;
  requestedToolNames: string[];
  safeBuiltinTools: string[];
  activeWebTools: string[];
  inactiveAvailableWebTools: string[];
  extensionPaths: string[];
}

export interface TaskJobResultPayload {
  request: string;
  profile: CodexTaskExecutionProfile;
  finalText: string;
  activeToolNames: string[];
  missingToolNames: string[];
  patchFile?: string;
  diffStat?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

interface BaseBackgroundJob {
  id: string;
  jobClass: CodexJobClass;
  kind: string;
  workspaceRoot: string;
  cwd: string;
  repoRoot: string;
  branch: string;
  originSessionId?: string;
  originSessionFile?: string;
  originCwd?: string;
  modelProvider: string;
  modelId: string;
  modelSpec: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastHeartbeatAt?: string;
  status: CodexJobStatus;
  phase: string;
  runnerPid?: number | null;
  errorMessage?: string;
  notificationDeliveredAt?: string;
  notifiedSessionId?: string;
  snapshotFile: string;
  resultFile: string;
  resultJsonFile: string;
  logFile: string;
}

export interface ReviewBackgroundJob extends BaseBackgroundJob {
  jobClass: "review";
  kind: CodexReviewJobKind;
  targetLabel: string;
  targetMode: "working-tree" | "branch";
  targetBaseRef?: string;
  focusText?: string;
  thinkingLevel?: CodexThinkingLevel;
  resultVerdict?: ReviewVerdict;
  requestedToolNames?: string[];
  activeToolNames?: string[];
  safeBuiltinTools?: string[];
  activeWebTools?: string[];
  inactiveAvailableWebTools?: string[];
  extensionPaths?: string[];
  missingToolNames?: string[];
  sessionDir?: string;
}

export interface ResearchBackgroundJob extends BaseBackgroundJob {
  jobClass: "research";
  kind: CodexResearchJobKind;
  request: string;
  requestSummary: string;
  thinkingLevel?: CodexThinkingLevel;
  nativeWebSearchEnabled?: boolean;
  requestedToolNames: string[];
  activeToolNames: string[];
  safeBuiltinTools: string[];
  activeWebTools: string[];
  inactiveAvailableWebTools: string[];
  extensionPaths: string[];
  missingToolNames?: string[];
  sessionDir: string;
}

export interface TaskBackgroundJob extends BaseBackgroundJob {
  jobClass: "task";
  kind: CodexTaskJobKind;
  profile: CodexTaskExecutionProfile;
  request: string;
  requestSummary: string;
  thinkingLevel?: CodexThinkingLevel;
  requestedToolNames: string[];
  activeToolNames: string[];
  safeBuiltinTools: string[];
  activeWebTools: string[];
  inactiveAvailableWebTools: string[];
  extensionPaths: string[];
  missingToolNames?: string[];
  sessionDir: string;
  executionCwd: string;
  patchFile?: string;
  diffStat?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseCommit?: string;
  syntheticPaths?: string[];
}

export type CodexBackgroundJob = ReviewBackgroundJob | ResearchBackgroundJob | TaskBackgroundJob;

export interface JobStatusSnapshot {
  id: string;
  jobClass: CodexJobClass;
  kind: string;
  status: CodexJobStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastHeartbeatAt?: string;
  repoRoot: string;
  branch: string;
  subject: string;
  resultVerdict?: ReviewVerdict;
  runnerPid?: number | null;
  errorMessage?: string;
}

export function isTerminalJobStatus(status: CodexJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}

export function isReviewBackgroundJob(job: CodexBackgroundJob): job is ReviewBackgroundJob {
  return job.jobClass === "review";
}

export function isResearchBackgroundJob(job: CodexBackgroundJob): job is ResearchBackgroundJob {
  return job.jobClass === "research";
}

export function isTaskBackgroundJob(job: CodexBackgroundJob): job is TaskBackgroundJob {
  return job.jobClass === "task";
}

export function backgroundJobSubject(job: CodexBackgroundJob): string {
  return job.jobClass === "review" ? job.targetLabel : job.requestSummary;
}
