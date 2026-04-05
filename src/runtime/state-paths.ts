import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";

export function getCodexHome(): string {
  return join(homedir(), ".pi", "agent", "codex");
}

export function ensureDir(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function workspaceSlug(cwd: string): string {
  const raw = basename(cwd) || "workspace";
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
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

function workspaceHash(cwd: string): string {
  const resolved = resolveWorkspaceRoot(cwd);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function getWorkspaceStateDir(cwd: string): string {
  const resolved = resolveWorkspaceRoot(cwd);
  return join(getCodexHome(), "workspaces", `${workspaceSlug(resolved)}-${workspaceHash(resolved)}`);
}

export function getWorkspaceReviewsDir(cwd: string): string {
  return ensureDir(join(getWorkspaceStateDir(cwd), "reviews"));
}
