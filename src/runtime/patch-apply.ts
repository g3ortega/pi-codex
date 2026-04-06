import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { TaskBackgroundJob } from "./job-types.js";

export interface AppliedTaskPatch {
  repoRoot: string;
  patchFile: string;
  diffStat: string;
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
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function ensureCleanRepo(repoRoot: string): void {
  const status = runGitChecked(repoRoot, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error("Applying a stored Codex patch requires a clean git working tree. Commit or stash changes first.");
  }
}

function resolveRepoRoot(cwd: string): string {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new Error("Applying a stored Codex patch requires a git repository.");
  }
  return realpathSync(runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

export function applyStoredTaskPatch(cwd: string, job: TaskBackgroundJob): AppliedTaskPatch {
  if (job.profile !== "write") {
    throw new Error("Only background write-task jobs can be applied back to the live repository.");
  }
  if (job.status !== "completed") {
    throw new Error("Only completed background write-task jobs can be applied.");
  }
  if (!job.patchFile || !existsSync(job.patchFile)) {
    throw new Error("This background write-task job does not have a stored patch artifact.");
  }
  if (!job.worktreeBaseCommit) {
    throw new Error("This background write-task job is missing its base commit metadata.");
  }

  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot !== realpathSync(job.repoRoot)) {
    throw new Error("The requested job belongs to a different repository.");
  }

  ensureCleanRepo(repoRoot);

  const currentHead = runGitChecked(repoRoot, ["rev-parse", "HEAD"]).trim();
  if (currentHead !== job.worktreeBaseCommit) {
    throw new Error(
      `The live repository head (${currentHead}) no longer matches the job base commit (${job.worktreeBaseCommit}). Re-run the task or apply the patch manually.`,
    );
  }

  const check = runGit(repoRoot, ["apply", "--check", job.patchFile]);
  if (check.status !== 0) {
    throw new Error(check.stderr.trim() || check.stdout.trim() || "Stored patch no longer applies cleanly.");
  }

  runGitChecked(repoRoot, ["apply", job.patchFile]);
  const diffStat = runGitChecked(repoRoot, ["diff", "--stat"]).trim();

  return {
    repoRoot,
    patchFile: job.patchFile,
    diffStat,
  };
}
