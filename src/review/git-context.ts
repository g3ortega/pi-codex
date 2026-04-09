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
const MAX_REVIEW_DIFF_CHARS = 600_000;
const GIT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_INLINE_BRANCH_TOTAL_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_BRANCH_SINGLE_FILE_BYTES = 512 * 1024;

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
    maxBuffer: GIT_MAX_BUFFER_BYTES,
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

function summarizeOmittedDiff(label: string, diff: string): string {
  const lines = diff.split("\n").length;
  return [
    `${label} omitted from inline review context because it is too large (${diff.length.toLocaleString()} characters, ${lines.toLocaleString()} lines).`,
    "Use the change map and read-only git inspection tools to inspect the highest-risk files on demand.",
  ].join("\n");
}

function summarizeEstimatedOmittedDiff(label: string, reason: string): string {
  return [
    `${label} omitted from inline review context because it is too large (${reason}).`,
    "Use the change map and read-only git inspection tools to inspect the highest-risk files on demand.",
  ].join("\n");
}

function maybeInlineDiff(label: string, diff: string): string {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
    return diff;
  }
  return summarizeOmittedDiff(label, diff);
}

type BranchChangedPath = {
  status: string;
  path: string;
  previousPath?: string;
};

function parseNameStatusZ(output: string): BranchChangedPath[] {
  const parts = output.split("\0").filter(Boolean);
  const entries: BranchChangedPath[] = [];

  for (let index = 0; index < parts.length;) {
    const statusToken = parts[index++];
    if (!statusToken) {
      continue;
    }

    const status = statusToken[0];
    if (status === "R" || status === "C") {
      const previousPath = parts[index++];
      const path = parts[index++];
      if (previousPath && path) {
        entries.push({ status, previousPath, path });
      }
      continue;
    }

    const path = parts[index++];
    if (path) {
      entries.push({ status, path });
    }
  }

  return entries;
}

function gitBlobSizes(cwd: string, objectSpecs: string[]): Map<string, number | null> {
  const uniqueSpecs = [...new Set(objectSpecs.filter(Boolean))];
  const sizes = new Map<string, number | null>();
  if (uniqueSpecs.length === 0) {
    return sizes;
  }

  const result = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objectsize)", "-z"], {
    cwd,
    input: `${uniqueSpecs.join("\0")}\0`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  if ((result.status ?? 1) !== 0) {
    for (const objectSpec of uniqueSpecs) {
      sizes.set(objectSpec, null);
    }
    return sizes;
  }

  const lines = (result.stdout ?? "").split("\n");
  for (const [index, objectSpec] of uniqueSpecs.entries()) {
    const line = lines[index]?.trim() ?? "";
    const match = line.match(/^\S+\s+(\d+)$/);
    if (!match) {
      sizes.set(objectSpec, null);
      continue;
    }

    const size = Number.parseInt(match[1], 10);
    sizes.set(objectSpec, Number.isFinite(size) && size >= 0 ? size : null);
  }

  return sizes;
}

function estimateBranchDiffTooLarge(
  cwd: string,
  mergeBase: string,
  changedPaths: BranchChangedPath[],
): { omit: boolean; reason?: string } {
  const candidateSpecsByEntry = changedPaths.map((entry) =>
    entry.status === "A"
      ? [`HEAD:${entry.path}`]
      : entry.status === "D"
        ? [`${mergeBase}:${entry.path}`]
        : entry.previousPath
          ? [`${mergeBase}:${entry.previousPath}`, `HEAD:${entry.path}`]
          : [`${mergeBase}:${entry.path}`, `HEAD:${entry.path}`],
  );
  const blobSizes = gitBlobSizes(cwd, candidateSpecsByEntry.flat());

  let totalBlobBytes = 0;
  for (const [index, entry] of changedPaths.entries()) {
    const candidateSpecs = candidateSpecsByEntry[index] ?? [];
    let largestBlobBytes = 0;
    for (const objectSpec of candidateSpecs) {
      const size = blobSizes.get(objectSpec) ?? null;
      if (size != null && size > largestBlobBytes) {
        largestBlobBytes = size;
      }
    }

    totalBlobBytes += largestBlobBytes;

    if (largestBlobBytes >= MAX_INLINE_BRANCH_SINGLE_FILE_BYTES) {
      return {
        omit: true,
        reason: `${entry.path} is ${largestBlobBytes.toLocaleString()} bytes, above the inline single-file threshold`,
      };
    }

    if (totalBlobBytes >= MAX_INLINE_BRANCH_TOTAL_BLOB_BYTES) {
      return {
        omit: true,
        reason: `changed file blobs total ${totalBlobBytes.toLocaleString()} bytes, above the inline branch-review threshold`,
      };
    }
  }

  return { omit: false };
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
      formatSection("Staged Diff", maybeInlineDiff("Staged diff", stagedDiff)),
      formatSection("Unstaged Diff", maybeInlineDiff("Unstaged diff", unstagedDiff)),
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
  const changedFiles = runGitChecked(cwd, ["diff", "--name-status", commitRange]).trim();
  const changedPaths = parseNameStatusZ(runGitChecked(cwd, ["diff", "--name-status", "-z", commitRange]));
  const diffEstimate = estimateBranchDiffTooLarge(cwd, mergeBase, changedPaths);
  const branchDiff = diffEstimate.omit
    ? summarizeEstimatedOmittedDiff("Branch diff", diffEstimate.reason ?? "estimated branch diff exceeds the inline review threshold")
    : maybeInlineDiff(
      "Branch diff",
      runGitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]),
    );

  return {
    mode: "branch" as const,
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Changed Files", changedFiles),
      formatSection("Branch Diff", branchDiff),
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
