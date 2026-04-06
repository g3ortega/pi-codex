import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import registerCodexNotifyExtension from "../extensions/notify/index.ts";
import {
  createResearchBackgroundJob,
  createReviewBackgroundJob,
  createTaskBackgroundJob,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  readBackgroundJob,
  writeResearchJobResult,
  writeReviewJobResult,
  writeTaskJobResult,
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
    originSessionId: "session-a",
    originSessionFile: "/tmp/session-a.jsonl",
    originCwd: workspaceRoot,
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
    originSessionId: "session-a",
    originSessionFile: "/tmp/session-a.jsonl",
    originCwd: workspaceRoot,
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
    executionCwd: workspaceRoot,
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

function buildTaskJob(workspaceRoot, overrides = {}) {
  const id = overrides.id ?? "task-job";
  return {
    id,
    jobClass: "task",
    kind: "task",
    profile: "readonly",
    workspaceRoot,
    cwd: workspaceRoot,
    repoRoot: workspaceRoot,
    branch: "main",
    originSessionId: "session-a",
    originSessionFile: "/tmp/session-a.jsonl",
    originCwd: workspaceRoot,
    request: "diagnose auth refresh",
    requestSummary: "diagnose auth refresh",
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

function buildTaskSnapshot(workspaceRoot, overrides = {}) {
  return {
    kind: "task",
    profile: "readonly",
    repoRoot: workspaceRoot,
    branch: "main",
    request: "diagnose auth refresh",
    modelSpec: "openai-codex/gpt-5.3-codex",
    requestedToolNames: ["read", "find"],
    safeBuiltinTools: ["read", "grep", "find", "ls"],
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    extensionPaths: [],
    ...overrides,
  };
}

function createFakePi() {
  const handlers = new Map();
  const sent = [];

  return {
    sent,
    handlers,
    api: {
      on(event, handler) {
        handlers.set(event, handler);
      },
      sendMessage(message, options) {
        sent.push({ message, options });
      },
    },
  };
}

function createSessionContext(cwd, sessionId = "session-a") {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    ui: {
      notify() {},
      setStatus() {},
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("background notifier delivers a completed review once for the originating session", async () => {
  const root = makeTempDir("pi-codex-notify-review-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      const job = buildReviewJob(workspaceRoot, {
        id: "review-notify",
        status: "completed",
        phase: "done",
        completedAt: iso(-250),
        updatedAt: iso(-250),
        resultVerdict: "needs-attention",
      });
      createReviewBackgroundJob(job, buildReviewSnapshot(workspaceRoot));
      writeReviewJobResult(
        workspaceRoot,
        job.id,
        {
          reviewRun: {
            id: job.id,
            kind: "review",
            createdAt: job.createdAt,
            repoRoot: workspaceRoot,
            branch: "main",
            targetLabel: "working tree diff",
            targetMode: "working-tree",
            modelProvider: "openai-codex",
            modelId: "gpt-5.3-codex",
            result: {
              verdict: "needs-attention",
              summary: "No-ship: synthetic notification test found a blocking issue.",
              findings: [],
              next_steps: [],
            },
            parseError: null,
            rawOutput: "{}",
          },
        },
        "# Codex Review\n\nSynthetic markdown\n",
      );

      const fake = createFakePi();
      registerCodexNotifyExtension(fake.api);
      await fake.handlers.get("session_start")(null, createSessionContext(workspaceRoot));

      await sleep(250);
      assert.equal(fake.sent.length, 1);
      assert.equal(fake.sent[0].message.customType, "codex-report");
      assert.match(fake.sent[0].message.content, /# Codex Review/);
      assert.match(fake.sent[0].message.content, /Synthetic markdown/);
      assert.equal(fake.sent[0].options?.triggerTurn, false);

      await sleep(250);
      assert.equal(fake.sent.length, 1);

      const refreshed = readBackgroundJob(workspaceRoot, job.id);
      assert.ok(refreshed?.notificationDeliveredAt);
      assert.equal(refreshed?.notifiedSessionId, "session-a");

      await fake.handlers.get("session_shutdown")();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background notifier ignores jobs from other sessions and still reports matching failed jobs", async () => {
  const root = makeTempDir("pi-codex-notify-filter-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      createReviewBackgroundJob(
        buildReviewJob(workspaceRoot, {
          id: "review-other-session",
          originSessionId: "session-b",
          originSessionFile: "/tmp/session-b.jsonl",
          status: "completed",
          phase: "done",
          completedAt: iso(-500),
          updatedAt: iso(-500),
          resultVerdict: "approve",
        }),
        buildReviewSnapshot(workspaceRoot),
      );

      createResearchBackgroundJob(
        buildResearchJob(workspaceRoot, {
          id: "research-failed",
          status: "failed",
          phase: "failed",
          completedAt: iso(-250),
          updatedAt: iso(-250),
          errorMessage: "Synthetic failure for notifier coverage.",
        }),
        buildResearchSnapshot(workspaceRoot),
      );

      const fake = createFakePi();
      registerCodexNotifyExtension(fake.api);
      await fake.handlers.get("session_start")(null, createSessionContext(workspaceRoot));

      await sleep(250);
      assert.equal(fake.sent.length, 1);
      assert.match(fake.sent[0].message.content, /Synthetic failure for notifier coverage\./);
      assert.doesNotMatch(fake.sent[0].message.content, /review-other-session/);

      await fake.handlers.get("session_shutdown")();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background notifier delivers a completed readonly task once for the originating session", async () => {
  const root = makeTempDir("pi-codex-notify-task-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      const job = buildTaskJob(workspaceRoot, {
        id: "task-notify",
        status: "completed",
        phase: "completed",
        completedAt: iso(-250),
        updatedAt: iso(-250),
      });
      createTaskBackgroundJob(job, buildTaskSnapshot(workspaceRoot));
      writeTaskJobResult(
        workspaceRoot,
        job.id,
        {
          request: "diagnose auth refresh",
          profile: "readonly",
          finalText: "Diagnosis complete. Proposed patch: restore auth refresh backoff.",
          activeToolNames: ["read", "grep"],
          missingToolNames: [],
        },
        "# Codex Task\n\nSynthetic task markdown\n",
      );

      const fake = createFakePi();
      registerCodexNotifyExtension(fake.api);
      await fake.handlers.get("session_start")(null, createSessionContext(workspaceRoot));

      await sleep(250);
      assert.equal(fake.sent.length, 1);
      assert.equal(fake.sent[0].message.customType, "codex-report");
      assert.match(fake.sent[0].message.content, /# Codex Task/);
      assert.match(fake.sent[0].message.content, /Synthetic task markdown/);
      assert.equal(fake.sent[0].options?.triggerTurn, false);

      await sleep(250);
      assert.equal(fake.sent.length, 1);

      const refreshed = readBackgroundJob(workspaceRoot, job.id);
      assert.ok(refreshed?.notificationDeliveredAt);
      assert.equal(refreshed?.notifiedSessionId, "session-a");

      await fake.handlers.get("session_shutdown")();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("background notifier previews long research results instead of inlining them fully", async () => {
  const root = makeTempDir("pi-codex-notify-research-long-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    await withHomeDir(homeDir, async () => {
      const job = buildResearchJob(workspaceRoot, {
        id: "research-notify-long",
        status: "completed",
        phase: "done",
        completedAt: iso(-250),
        updatedAt: iso(-250),
      });
      createResearchBackgroundJob(job, buildResearchSnapshot(workspaceRoot));

      const longAnswer = "A".repeat(2_600);
      const markdown = [
        "# Codex Research",
        "",
        "- Job ID: research-notify-long",
        "",
        "Final answer:",
        "",
        "## Findings",
        "",
        "- First substantive finding for the preview.",
        "- Second substantive finding for the preview.",
        "",
        longAnswer,
      ].join("\n");

      writeResearchJobResult(
        workspaceRoot,
        job.id,
        {
          request: "investigate background mode",
          finalText: "This is a long research result that should be previewed instead of inlined.",
          activeToolNames: ["read", "find"],
          missingToolNames: [],
        },
        markdown,
      );

      const fake = createFakePi();
      registerCodexNotifyExtension(fake.api);
      await fake.handlers.get("session_start")(null, createSessionContext(workspaceRoot));

      await sleep(250);
      assert.equal(fake.sent.length, 1);
      assert.match(fake.sent[0].message.content, /# Codex Research Complete/);
      assert.match(fake.sent[0].message.content, /Preview:/);
      assert.match(fake.sent[0].message.content, /First substantive finding for the preview\./);
      assert.match(fake.sent[0].message.content, /Result was too long to inline fully/);
      assert.match(fake.sent[0].message.content, /Use `\/codex:result research-notify-long` for the full stored research result\./);
      assert.doesNotMatch(fake.sent[0].message.content, /^# Codex Research\n\n- Job ID: research-notify-long\n\nFinal answer:/m);

      await fake.handlers.get("session_shutdown")();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
