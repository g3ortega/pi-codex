import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

export function getCodexHome(): string {
  return ensureDir(join(homedir(), ".pi", "agent", "codex"));
}

function getCodexWorkspacesHome(): string {
  return ensureDir(join(getCodexHome(), "workspaces"));
}

export function ensureDir(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best effort only. Existing directories may be owned by another process or platform policy.
  }

  return dirPath;
}

function workspaceSlug(cwd: string): string {
  const raw = basename(cwd) || "workspace";
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  try {
    return realpathSync.native(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}

function resolveWorkspaceRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if ((result.status ?? 1) === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}

export function getWorkspaceRoot(cwd: string): string {
  return resolveWorkspaceRoot(cwd);
}

function workspaceHashFromRoot(workspaceRoot: string): string {
  return createHash("sha256").update(canonicalWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 16);
}

function workspaceHash(cwd: string): string {
  return workspaceHashFromRoot(resolveWorkspaceRoot(cwd));
}

export function getWorkspaceStateDir(cwd: string): string {
  const resolved = resolveWorkspaceRoot(cwd);
  return ensureDir(join(getCodexWorkspacesHome(), `${workspaceSlug(resolved)}-${workspaceHash(resolved)}`));
}

export function getWorkspaceStateDirForRoot(workspaceRoot: string): string {
  const resolved = canonicalWorkspaceRoot(workspaceRoot);
  return ensureDir(join(getCodexWorkspacesHome(), `${workspaceSlug(resolved)}-${workspaceHashFromRoot(resolved)}`));
}

export function getWorkspaceReviewsDir(cwd: string): string {
  return ensureDir(join(getWorkspaceStateDir(cwd), "reviews"));
}

export function getWorkspaceJobsDir(cwd: string): string {
  return ensureDir(join(getWorkspaceStateDir(cwd), "jobs"));
}

export function getWorkspaceJobsDirForRoot(workspaceRoot: string): string {
  return ensureDir(join(getWorkspaceStateDirForRoot(workspaceRoot), "jobs"));
}
