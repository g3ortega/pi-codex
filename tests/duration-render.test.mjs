import test from "node:test";
import assert from "node:assert/strict";

import { formatDurationMs, parseTimestampMs, summarizeBackgroundDurations, summarizeReviewDuration } from "../src/runtime/duration.ts";
import { renderBackgroundJobCompletionMarkdown, renderBackgroundJobMarkdown } from "../src/runtime/job-render.ts";
import { renderStoredResearchMarkdown } from "../src/research/research-render.ts";
import { renderStoredReviewMarkdown } from "../src/review/review-render.ts";
import { renderStoredTaskMarkdown } from "../src/task/task-render.ts";

function reviewJob(overrides = {}) {
  return {
    id: "review-job",
    jobClass: "review",
    kind: "review",
    workspaceRoot: "/tmp/workspace",
    cwd: "/tmp/workspace",
    repoRoot: "/tmp/workspace",
    branch: "main",
    targetLabel: "working tree diff",
    targetMode: "working-tree",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    modelSpec: "openai-codex/gpt-5.3-codex",
    createdAt: "2026-04-06T10:00:00.000Z",
    updatedAt: "2026-04-06T10:04:52.000Z",
    startedAt: "2026-04-06T10:00:01.000Z",
    completedAt: "2026-04-06T10:04:52.000Z",
    status: "completed",
    phase: "done",
    snapshotFile: "/tmp/workspace/job/snapshot.json",
    resultFile: "/tmp/workspace/job/result.md",
    resultJsonFile: "/tmp/workspace/job/result.json",
    logFile: "/tmp/workspace/job/run.log",
    resultVerdict: "needs-attention",
    ...overrides,
  };
}

function researchJob(overrides = {}) {
  return {
    id: "research-job",
    jobClass: "research",
    kind: "research",
    workspaceRoot: "/tmp/workspace",
    cwd: "/tmp/workspace",
    repoRoot: "/tmp/workspace",
    branch: "main",
    request: "summarize the repo",
    requestSummary: "summarize the repo",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    modelSpec: "openai-codex/gpt-5.3-codex",
    createdAt: "2026-04-06T10:00:00.000Z",
    updatedAt: "2026-04-06T10:04:52.000Z",
    startedAt: "2026-04-06T10:00:01.000Z",
    completedAt: "2026-04-06T10:04:52.000Z",
    status: "completed",
    phase: "done",
    requestedToolNames: ["read", "find"],
    activeToolNames: ["read", "find"],
    safeBuiltinTools: ["read", "grep", "find", "ls"],
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    extensionPaths: [],
    sessionDir: "/tmp/workspace/job/session",
    executionCwd: "/tmp/workspace",
    snapshotFile: "/tmp/workspace/job/snapshot.json",
    resultFile: "/tmp/workspace/job/result.md",
    resultJsonFile: "/tmp/workspace/job/result.json",
    logFile: "/tmp/workspace/job/run.log",
    ...overrides,
  };
}

function taskJob(overrides = {}) {
  return {
    id: "task-job",
    jobClass: "task",
    kind: "task",
    profile: "readonly",
    workspaceRoot: "/tmp/workspace",
    cwd: "/tmp/workspace",
    repoRoot: "/tmp/workspace",
    branch: "main",
    request: "diagnose auth refresh",
    requestSummary: "diagnose auth refresh",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    modelSpec: "openai-codex/gpt-5.3-codex",
    createdAt: "2026-04-06T10:00:00.000Z",
    updatedAt: "2026-04-06T10:04:52.000Z",
    startedAt: "2026-04-06T10:00:01.000Z",
    completedAt: "2026-04-06T10:04:52.000Z",
    status: "completed",
    phase: "done",
    requestedToolNames: ["read", "find"],
    activeToolNames: ["read", "find"],
    safeBuiltinTools: ["read", "grep", "find", "ls"],
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    extensionPaths: [],
    sessionDir: "/tmp/workspace/job/session",
    executionCwd: "/tmp/workspace",
    snapshotFile: "/tmp/workspace/job/snapshot.json",
    resultFile: "/tmp/workspace/job/result.md",
    resultJsonFile: "/tmp/workspace/job/result.json",
    logFile: "/tmp/workspace/job/run.log",
    ...overrides,
  };
}

test("duration helpers format concise labels and reject invalid timestamps", () => {
  assert.equal(parseTimestampMs("not-a-date"), null);
  assert.equal(formatDurationMs(650), "650ms");
  assert.equal(formatDurationMs(8_500), "8.5s");
  assert.equal(formatDurationMs(235_000), "3m 55s");
  assert.equal(formatDurationMs(3_780_000), "1h 3m");
});

test("background duration summary exposes queue, run, and total durations", () => {
  assert.deepEqual(
    summarizeBackgroundDurations(researchJob()),
    {
      queueDelay: "1s",
      runDuration: "4m 51s",
      totalDuration: "4m 52s",
      runningFor: null,
    },
  );
});

test("background job status render includes timing labels", () => {
  const markdown = renderBackgroundJobMarkdown(researchJob());
  assert.match(markdown, /- Queue delay: 1s/);
  assert.match(markdown, /- Run duration: 4m 51s/);
  assert.match(markdown, /- Total duration: 4m 52s/);
});

test("background job status render shows running-for for active jobs", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-04-06T10:01:45.000Z");
  try {
    const markdown = renderBackgroundJobMarkdown(researchJob({
      status: "running",
      phase: "agent-turn",
      completedAt: undefined,
      updatedAt: "2026-04-06T10:01:45.000Z",
    }));
    assert.match(markdown, /- Running for: 1m 44s/);
    assert.doesNotMatch(markdown, /- Run duration:/);
    assert.doesNotMatch(markdown, /- Total duration:/);
  } finally {
    Date.now = originalNow;
  }
});

test("background completion render includes a human timing summary", () => {
  const completed = renderBackgroundJobCompletionMarkdown(reviewJob(), "No-ship: partial rollback risk.");
  assert.match(completed, /- Timing: Completed in 4m 52s/);

  const failed = renderBackgroundJobCompletionMarkdown(researchJob({
    status: "failed",
    phase: "failed",
    errorMessage: "Timed out",
  }));
  assert.match(failed, /- Timing: Failed after 4m 52s/);
});

test("stored research and task markdown include duration fields", () => {
  const researchMarkdown = renderStoredResearchMarkdown(researchJob(), {
    request: "summarize the repo",
    finalText: "Answer",
    activeToolNames: ["find", "read"],
    missingToolNames: [],
  });
  assert.match(researchMarkdown, /- Queue delay: 1s/);
  assert.match(researchMarkdown, /- Run duration: 4m 51s/);
  assert.match(researchMarkdown, /- Total duration: 4m 52s/);

  const taskMarkdown = renderStoredTaskMarkdown(taskJob(), {
    request: "diagnose auth refresh",
    profile: "readonly",
    finalText: "Diagnosis",
    activeToolNames: ["find", "read"],
    missingToolNames: [],
  });
  assert.match(taskMarkdown, /- Queue delay: 1s/);
  assert.match(taskMarkdown, /- Run duration: 4m 51s/);
  assert.match(taskMarkdown, /- Total duration: 4m 52s/);
});

test("stored review markdown includes completion timing", () => {
  const markdown = renderStoredReviewMarkdown({
    id: "review-123",
    kind: "review",
    createdAt: "2026-04-06T10:04:52.000Z",
    startedAt: "2026-04-06T10:00:00.000Z",
    completedAt: "2026-04-06T10:04:52.000Z",
    repoRoot: "/tmp/workspace",
    branch: "main",
    targetLabel: "working tree diff",
    targetMode: "working-tree",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    result: {
      verdict: "approve",
      summary: "Looks safe.",
      findings: [],
      next_steps: [],
    },
    parseError: null,
    rawOutput: "{}",
  });
  assert.equal(summarizeReviewDuration({
    createdAt: "2026-04-06T10:04:52.000Z",
    startedAt: "2026-04-06T10:00:00.000Z",
    completedAt: "2026-04-06T10:04:52.000Z",
  }), "4m 52s");
  assert.match(markdown, /- Created: 2026-04-06T10:04:52.000Z/);
  assert.doesNotMatch(markdown, /- Completed:/);
  assert.match(markdown, /- Duration: 4m 52s/);
});

test("stored background review markdown includes queue, run, and total durations", () => {
  const markdown = renderStoredReviewMarkdown(
    {
      id: "review-background-123",
      kind: "adversarial-review",
      createdAt: "2026-04-06T10:04:52.000Z",
      startedAt: "2026-04-06T10:00:01.000Z",
      completedAt: "2026-04-06T10:04:52.000Z",
      repoRoot: "/tmp/workspace",
      branch: "main",
      targetLabel: "working tree diff",
      targetMode: "working-tree",
      modelProvider: "openai-codex",
      modelId: "gpt-5.3-codex",
      result: {
        verdict: "needs-attention",
        summary: "No-ship.",
        findings: [],
        next_steps: [],
      },
      parseError: null,
      rawOutput: "{}",
    },
    {
      backgroundTiming: {
        createdAt: "2026-04-06T10:00:00.000Z",
        startedAt: "2026-04-06T10:00:01.000Z",
        completedAt: "2026-04-06T10:04:52.000Z",
        status: "completed",
      },
    },
  );
  assert.match(markdown, /- Queue delay: 1s/);
  assert.match(markdown, /- Run duration: 4m 51s/);
  assert.match(markdown, /- Total duration: 4m 52s/);
  assert.doesNotMatch(markdown, /- Duration:/);
});

test("stored review markdown omits duration fields for legacy review records", () => {
  const markdown = renderStoredReviewMarkdown({
    id: "review-legacy",
    kind: "review",
    createdAt: "2026-04-06T10:00:00.000Z",
    repoRoot: "/tmp/workspace",
    branch: "main",
    targetLabel: "working tree diff",
    targetMode: "working-tree",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    result: {
      verdict: "approve",
      summary: "Looks safe.",
      findings: [],
      next_steps: [],
    },
    parseError: null,
    rawOutput: "{}",
  });
  assert.doesNotMatch(markdown, /- Completed:/);
  assert.doesNotMatch(markdown, /- Duration:/);
});
