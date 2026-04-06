import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TaskWorktreeSetup {
  repoRoot: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
  agentCwd: string;
  syntheticPaths: string[];
}

export interface TaskWorktreeDiff {
  patchFile: string;
  diffStat: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runGitChecked(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

function ensureCleanRepo(cwd: string): { repoRoot: string; cwdRelative: string; baseCommit: string } {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new Error("Background task-write requires a git repository.");
  }

  const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const status = runGitChecked(repoRoot, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error("Background task-write requires a clean git working tree. Commit or stash changes first.");
  }

  const realRepoRoot = realpathSync(repoRoot);
  const realCwd = realpathSync(cwd);
  const cwdRelative = path.relative(realRepoRoot, realCwd);
  const baseCommit = runGitChecked(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { repoRoot: realRepoRoot, cwdRelative, baseCommit };
}

function buildWorktreeBranch(runId: string): string {
  return `pi-codex-task-${runId}`;
}

function buildWorktreePath(runId: string): string {
  return path.join(os.tmpdir(), `pi-codex-worktree-${runId}`);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
  const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function linkNodeModulesIfPresent(repoRoot: string, worktreePath: string): string[] {
  const source = path.join(repoRoot, "node_modules");
  const target = path.join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target) || hasTrackedEntries(worktreePath, "node_modules")) {
    return [];
  }
  try {
    symlinkSync(source, target);
    return ["node_modules"];
  } catch {
    return [];
  }
}

function removeSyntheticPath(worktreePath: string, relativePath: string): void {
  const resolved = path.resolve(worktreePath, relativePath);
  const relative = path.relative(worktreePath, resolved);
  if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return;
  }

  try {
    const stats = lstatSync(resolved);
    if (stats.isSymbolicLink()) {
      rmSync(resolved, { force: true });
      return;
    }
    if (stats.isDirectory()) {
      rmSync(resolved, { recursive: true, force: true });
      return;
    }
    rmSync(resolved, { force: true });
  } catch {
    // Best effort only.
  }
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of numstat.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const [rawInsertions, rawDeletions] = line.split("\t");
    if (rawInsertions === undefined || rawDeletions === undefined) {
      continue;
    }
    filesChanged += 1;
    if (/^\d+$/.test(rawInsertions)) {
      insertions += Number.parseInt(rawInsertions, 10);
    }
    if (/^\d+$/.test(rawDeletions)) {
      deletions += Number.parseInt(rawDeletions, 10);
    }
  }

  return { filesChanged, insertions, deletions };
}

export function createTaskWorktree(cwd: string, runId: string): TaskWorktreeSetup {
  const repo = ensureCleanRepo(cwd);
  const branch = buildWorktreeBranch(runId);
  const worktreePath = buildWorktreePath(runId);
  const add = runGit(repo.repoRoot, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
  if (add.status !== 0) {
    const message = add.stderr.trim() || add.stdout.trim() || `Failed to create worktree ${worktreePath}.`;
    throw new Error(message);
  }

  try {
    const syntheticPaths = linkNodeModulesIfPresent(repo.repoRoot, worktreePath);
    const agentCwd = repo.cwdRelative ? path.join(worktreePath, repo.cwdRelative) : worktreePath;
    mkdirSync(agentCwd, { recursive: true });
    return {
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branch,
      worktreePath,
      agentCwd,
      syntheticPaths,
    };
  } catch (error) {
    try {
      runGitChecked(repo.repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {}
    try {
      runGitChecked(repo.repoRoot, ["branch", "-D", branch]);
    } catch {}
    throw error;
  }
}

export function captureTaskWorktreeDiff(setup: TaskWorktreeSetup, patchFile: string): TaskWorktreeDiff {
  for (const syntheticPath of new Set(setup.syntheticPaths)) {
    removeSyntheticPath(setup.worktreePath, syntheticPath);
  }

  runGitChecked(setup.worktreePath, ["add", "-A"]);
  const diffStat = runGitChecked(setup.worktreePath, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
  const patch = runGitChecked(setup.worktreePath, ["diff", "--cached", setup.baseCommit]);
  const numstat = runGitChecked(setup.worktreePath, ["diff", "--cached", "--numstat", setup.baseCommit]);
  writeFileSync(patchFile, patch, { encoding: "utf8" });
  const parsed = parseNumstat(numstat);
  return {
    patchFile,
    diffStat,
    filesChanged: parsed.filesChanged,
    insertions: parsed.insertions,
    deletions: parsed.deletions,
  };
}

export function cleanupTaskWorktree(setup: TaskWorktreeSetup): void {
  try {
    runGitChecked(setup.repoRoot, ["worktree", "remove", "--force", setup.worktreePath]);
  } catch {
    // Best effort only.
  }
  try {
    runGitChecked(setup.repoRoot, ["branch", "-D", setup.branch]);
  } catch {
    // Best effort only.
  }
  try {
    runGitChecked(setup.repoRoot, ["worktree", "prune"]);
  } catch {
    // Best effort only.
  }
}
