import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDetachedResearchJob } from "../src/background/research-job.ts";
import { runDetachedReviewJob } from "../src/background/review-job.ts";
import {
  cancelBackgroundJob,
  createResearchBackgroundJob,
  createReviewBackgroundJob,
  findBackgroundJob,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  readBackgroundJob,
  updateBackgroundJob,
} from "../src/runtime/job-store.ts";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withHomeDir(homeDir, fn) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function buildReviewJob(workspaceRoot, overrides = {}) {
  const id = overrides.id ?? "review-job";
  return {
    id,
    jobClass: "review",
    kind: "review",
    workspaceRoot,
    cwd: workspaceRoot,
    repoRoot: workspaceRoot,
    branch: "main",
    targetLabel: "working tree diff",
    targetMode: "working-tree",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    modelSpec: "openai-codex/gpt-5.3-codex",
    createdAt: iso(),
    updatedAt: iso(),
    status: "queued",
    phase: "queued",
    snapshotFile: getJobSnapshotFile(workspaceRoot, id),
    resultFile: getJobResultFile(workspaceRoot, id),
    resultJsonFile: getJobResultJsonFile(workspaceRoot, id),
    logFile: getJobLogFile(workspaceRoot, id),
    ...overrides,
  };
}

function buildReviewSnapshot(workspaceRoot, overrides = {}) {
  return {
    kind: "review",
    repoRoot: workspaceRoot,
    branch: "main",
    targetLabel: "working tree diff",
    targetMode: "working-tree",
    modelSpec: "openai-codex/gpt-5.3-codex",
    reviewInput: "synthetic diff",
    ...overrides,
  };
}

function buildResearchJob(workspaceRoot, overrides = {}) {
  const id = overrides.id ?? "research-job";
  return {
    id,
    jobClass: "research",
    kind: "research",
    workspaceRoot,
    cwd: workspaceRoot,
    repoRoot: workspaceRoot,
    branch: "main",
    request: "investigate background mode",
    requestSummary: "investigate background mode",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    modelSpec: "openai-codex/gpt-5.3-codex",
    createdAt: iso(),
    updatedAt: iso(),
    status: "queued",
    phase: "queued",
    requestedToolNames: ["read", "find"],
    activeToolNames: [],
    safeBuiltinTools: ["read", "grep", "find", "ls"],
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    extensionPaths: [],
    sessionDir: getJobSessionDir(workspaceRoot, id),
    snapshotFile: getJobSnapshotFile(workspaceRoot, id),
    resultFile: getJobResultFile(workspaceRoot, id),
    resultJsonFile: getJobResultJsonFile(workspaceRoot, id),
    logFile: getJobLogFile(workspaceRoot, id),
    ...overrides,
  };
}

function buildResearchSnapshot(workspaceRoot, overrides = {}) {
  return {
    kind: "research",
    repoRoot: workspaceRoot,
    branch: "main",
    request: "investigate background mode",
    modelSpec: "openai-codex/gpt-5.3-codex",
    requestedToolNames: ["read", "find"],
    safeBuiltinTools: ["read", "grep", "find", "ls"],
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    extensionPaths: [],
    ...overrides,
  };
}

const DUMMY_SETTINGS = {
  defaultReviewScope: "auto",
  defaultReviewModel: undefined,
  reviewHistoryLimit: 25,
  protectLockfiles: false,
  enableTaskCommand: true,
  enableResearchCommand: true,
  protectedPaths: [".env", ".git/", "node_modules/"],
};

test("cancelBackgroundJob only targets active jobs and findBackgroundJob supports active-only lookup", async () => {
  const root = makeTempDir("pi-codex-job-cancel-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-done",
          createdAt: iso(-2_000),
          updatedAt: iso(-2_000),
          completedAt: iso(-1_000),
          status: "completed",
          phase: "done",
          resultVerdict: "approve",
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      createResearchBackgroundJob(
        buildResearchJob(workspaceRoot, {
          id: "research-live",
          createdAt: iso(-1_000),
          updatedAt: iso(-1_000),
          status: "running",
          phase: "agent-turn",
          runnerPid: null,
        }),
        buildResearchSnapshot(workspaceRoot),
      );

      assert.equal(findBackgroundJob(workspaceRoot, "review-done")?.id, "review-done");
      assert.equal(findBackgroundJob(workspaceRoot, "review-done", { preferActive: true })?.id, "review-done");
      assert.equal(findBackgroundJob(workspaceRoot, "review-done", { activeOnly: true }), null);
      assert.equal(cancelBackgroundJob(workspaceRoot, "review-done"), null);

      const cancelled = cancelBackgroundJob(workspaceRoot);
      assert.equal(cancelled?.id, "research-live");
      assert.equal(cancelled?.status, "cancelling");

      const refreshed = readBackgroundJob(workspaceRoot, "research-live");
      assert.equal(refreshed?.status, "cancelling");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancelBackgroundJob returns null when a workspace only has terminal jobs", async () => {
  const root = makeTempDir("pi-codex-job-cancel-terminal-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-only-complete",
          status: "completed",
          phase: "done",
          completedAt: iso(-500),
          resultVerdict: "approve",
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      assert.equal(cancelBackgroundJob(workspaceRoot), null);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background job store preserves terminal states and reconciles stale runners", async () => {
  const root = makeTempDir("pi-codex-job-state-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-complete",
          status: "completed",
          phase: "done",
          completedAt: iso(-1_000),
          resultVerdict: "approve",
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      const unchanged = updateBackgroundJob(workspaceRoot, "review-complete", (current) => ({
        ...current,
        status: "running",
        phase: "regressed",
      }));
      assert.equal(unchanged.status, "completed");
      assert.equal(unchanged.phase, "done");

      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-stale",
          createdAt: iso(-10_000),
          updatedAt: iso(-10_000),
          lastHeartbeatAt: iso(-10_000),
          status: "running",
          phase: "model-completion",
          runnerPid: null,
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      createResearchBackgroundJob(
        buildResearchJob(workspaceRoot, {
          id: "research-cancelling",
          createdAt: iso(-10_000),
          updatedAt: iso(-10_000),
          lastHeartbeatAt: iso(-10_000),
          status: "cancelling",
          phase: "cancelling",
          runnerPid: null,
        }),
        buildResearchSnapshot(workspaceRoot),
      );

      assert.equal(readBackgroundJob(workspaceRoot, "review-stale")?.status, "lost");
      assert.equal(readBackgroundJob(workspaceRoot, "research-cancelling")?.status, "cancelled");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detached runner entry paths short-circuit already-cancelled jobs before live execution", async () => {
  const root = makeTempDir("pi-codex-detached-entry-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-cancelling",
          status: "cancelling",
          phase: "cancelling",
          updatedAt: iso(),
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      createResearchBackgroundJob(
        buildResearchJob(workspaceRoot, {
          id: "research-cancelling",
          status: "cancelling",
          phase: "cancelling",
          updatedAt: iso(),
        }),
        buildResearchSnapshot(workspaceRoot),
      );

      const reviewResult = await runDetachedReviewJob(
        { cwd: workspaceRoot },
        DUMMY_SETTINGS,
        "review-cancelling",
      );
      assert.equal(reviewResult.status, "cancelled");

      const researchResult = await runDetachedResearchJob(
        {
          getAllTools() {
            return [];
          },
          setActiveTools() {},
          on() {},
          sendUserMessage() {
            throw new Error("sendUserMessage should not be reached for pre-cancelled research jobs");
          },
        },
        {
          cwd: workspaceRoot,
          abort() {
            throw new Error("abort should not be reached for pre-cancelled research jobs");
          },
        },
        DUMMY_SETTINGS,
        "research-cancelling",
      );
      assert.equal(researchResult.status, "cancelled");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detached review runner fails with a terminal error when the model call exceeds the watchdog", async () => {
  const root = makeTempDir("pi-codex-review-timeout-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-timeout",
          status: "queued",
          phase: "queued",
          updatedAt: iso(),
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      await assert.rejects(
        runDetachedReviewJob(
          { cwd: workspaceRoot },
          DUMMY_SETTINGS,
          "review-timeout",
          {
            timeoutMs: 25,
            executeReview: async (_ctx, _settings, _input, options = {}) =>
              await new Promise((_resolve, reject) => {
                const signal = options.signal;
                const keepAlive = setInterval(() => {}, 1_000);
                if (!signal) {
                  clearInterval(keepAlive);
                  reject(new Error("Missing abort signal."));
                  return;
                }
                if (signal.aborted) {
                  clearInterval(keepAlive);
                  reject(signal.reason ?? new Error("aborted"));
                  return;
                }
                signal.addEventListener(
                  "abort",
                  () => {
                    clearInterval(keepAlive);
                    reject(signal.reason ?? new Error("aborted"));
                  },
                  { once: true },
                );
              }),
          },
        ),
        /terminal review result/i,
      );

      const stored = readBackgroundJob(workspaceRoot, "review-timeout");
      assert.equal(stored?.status, "failed");
      assert.equal(stored?.phase, "failed");
      assert.match(stored?.errorMessage ?? "", /terminal review result/i);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
