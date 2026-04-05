import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type ReviewScope = "auto" | "working-tree" | "branch";

export interface ReviewTarget {
  mode: "working-tree" | "branch";
  label: string;
  baseRef?: string;
  explicit: boolean;
}

export interface ReviewContext {
  cwd: string;
  repoRoot: string;
  branch: string;
  target: ReviewTarget;
  mode: "working-tree" | "branch";
  summary: string;
  content: string;
}

const MAX_UNTRACKED_BYTES = 24 * 1024;

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: unknown;
};

function runGit(cwd: string, args: string[]): RunResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runGitChecked(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result.stdout;
}

function hasRef(cwd: string, ref: string): boolean {
  return runGit(cwd, ["show-ref", "--verify", "--quiet", ref]).status === 0;
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function formatSection(title: string, body: string): string {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

export function ensureGitRepository(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error) {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd: string): string {
  return runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function getCurrentBranch(cwd: string): string {
  return runGitChecked(cwd, ["branch", "--show-current"]).trim() || "HEAD";
}

export function detectDefaultBranch(cwd: string): string {
  const symbolic = runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const branchName = remoteHead.replace("refs/remotes/origin/", "");
      if (hasRef(cwd, `refs/heads/${branchName}`)) {
        return branchName;
      }
      if (hasRef(cwd, `refs/remotes/origin/${branchName}`)) {
        return `origin/${branchName}`;
      }
    }
  }

  for (const candidate of ["main", "master", "trunk"]) {
    if (hasRef(cwd, `refs/heads/${candidate}`)) {
      return candidate;
    }
    if (hasRef(cwd, `refs/remotes/origin/${candidate}`)) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getWorkingTreeState(cwd: string): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isDirty: boolean;
} {
  const staged = runGitChecked(cwd, ["diff", "--cached", "--name-only"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const unstaged = runGitChecked(cwd, ["diff", "--name-only"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const untracked = runGitChecked(cwd, ["ls-files", "--others", "--exclude-standard"])
    .trim()
    .split("\n")
    .filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  };
}

export function resolveReviewTarget(cwd: string, options: { scope?: ReviewScope; base?: string } = {}): ReviewTarget {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const state = getWorkingTreeState(cwd);

  if (options.base) {
    return {
      mode: "branch",
      label: `branch diff against ${options.base}`,
      baseRef: options.base,
      explicit: true,
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true,
    };
  }

  if (requestedScope === "branch") {
    const baseRef = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true,
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false,
    };
  }

  const baseRef = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${baseRef}`,
    baseRef,
    explicit: false,
  };
}

function formatUntrackedFile(cwd: string, relativePath: string): string {
  const absolutePath = join(cwd, relativePath);
  const stats = statSync(absolutePath);
  if (stats.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stats.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd: string, state: ReturnType<typeof getWorkingTreeState>) {
  const status = runGitChecked(cwd, ["status", "--short"]).trim();
  const stagedDiff = runGitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]);
  const unstagedDiff = runGitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]);
  const untrackedBody = state.untracked.map((filePath) => formatUntrackedFile(cwd, filePath)).join("\n\n");

  return {
    mode: "working-tree" as const,
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody),
    ].join("\n"),
  };
}

function collectBranchContext(cwd: string, baseRef: string) {
  const mergeBase = runGitChecked(cwd, ["merge-base", "HEAD", baseRef]).trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = runGitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).trim();
  const diffStat = runGitChecked(cwd, ["diff", "--stat", commitRange]).trim();
  const diff = runGitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]);

  return {
    mode: "branch" as const,
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff),
    ].join("\n"),
  };
}

export function collectReviewContext(cwd: string, target: ReviewTarget): ReviewContext {
  const repoRoot = getRepoRoot(cwd);
  const branch = getCurrentBranch(repoRoot);
  const state = getWorkingTreeState(repoRoot);

  const details =
    target.mode === "working-tree"
      ? collectWorkingTreeContext(repoRoot, state)
      : collectBranchContext(repoRoot, target.baseRef ?? detectDefaultBranch(repoRoot));

  return {
    cwd: repoRoot,
    repoRoot,
    branch,
    target,
    ...details,
  };
}
