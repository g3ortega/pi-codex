import { chmodSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceReviewsDir } from "./state-paths.js";
import type { StoredReviewRun } from "../review/review-schema.js";

export function generateReviewId(prefix = "review"): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function readRun(filePath: string): StoredReviewRun {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as StoredReviewRun;
}

function reviewFiles(cwd: string): string[] {
  const reviewDir = getWorkspaceReviewsDir(cwd);
  return readdirSync(reviewDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(reviewDir, name));
}

export function storedReviewSortKey(run: StoredReviewRun): string {
  return run.completedAt ?? run.createdAt;
}

export function listStoredReviews(cwd: string): StoredReviewRun[] {
  return reviewFiles(cwd)
    .map((filePath) => {
      try {
        return readRun(filePath);
      } catch {
        return null;
      }
    })
    .filter((value): value is StoredReviewRun => value !== null)
    .sort((left, right) => storedReviewSortKey(right).localeCompare(storedReviewSortKey(left)));
}

export function findStoredReview(cwd: string, reference?: string): StoredReviewRun | null {
  const runs = listStoredReviews(cwd);
  if (!reference) {
    return runs[0] ?? null;
  }

  const exact = runs.find((run) => run.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = runs.filter((run) => run.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Review reference "${reference}" is ambiguous. Use a longer id.`);
  }
  return null;
}

export function storeReviewRun(cwd: string, run: StoredReviewRun, limit: number): void {
  const reviewDir = getWorkspaceReviewsDir(cwd);
  const filePath = join(reviewDir, `${run.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
  pruneReviewRuns(cwd, limit);
}

function pruneReviewRuns(cwd: string, limit: number): void {
  const safeLimit = Math.max(1, limit);
  const runs = listStoredReviews(cwd);
  const reviewDir = getWorkspaceReviewsDir(cwd);

  for (const run of runs.slice(safeLimit)) {
    const filePath = join(reviewDir, `${run.id}.json`);
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore stale entries.
    }
  }

  for (const filePath of reviewFiles(cwd)) {
    try {
      const stats = statSync(filePath);
      if (stats.size === 0) {
        rmSync(filePath, { force: true });
      }
    } catch {
      // Ignore unreadable files.
    }
  }
}
