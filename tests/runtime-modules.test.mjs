import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import registerCodexExtension from "../extensions/core/index.ts";
import {
  buildStructuredReviewPrompt,
  buildStructuredReviewSynthesisPrompt,
  renderCandidateReviewForSynthesis,
  resolveSafeAdjacentEvidencePath,
  reviewAbortError,
} from "../src/review/review-runner.ts";
import { splitLeadingOptionTokens, splitShellLikeArgs } from "../src/runtime/arg-parser.ts";
import {
  ensureHeadlessReadOnlyBashWhitelisted,
  findReadOnlyScopeViolation,
  findReadOnlyScopeViolationInBashCommand,
  findProtectedPathInBashCommand,
  findProtectedPathMatch,
  isLikelyReadOnlyShellCommand,
} from "../src/runtime/path-protection.ts";
import { collectReviewContext } from "../src/review/git-context.ts";
import { findStoredReview, listStoredReviews, storeReviewRun, storedReviewSortKey } from "../src/runtime/review-store.ts";
import { parseTaskCommandOptions } from "../src/runtime/task-command-options.ts";
import {
  createResearchBackgroundJob,
  getJobLogFile,
  getJobResultFile,
  getJobResultJsonFile,
  getJobSessionDir,
  getJobSnapshotFile,
  writeResearchJobResult,
} from "../src/runtime/job-store.ts";
import {
  getCodexHome,
  getWorkspaceJobsDir,
  getWorkspaceJobsDirForRoot,
  getWorkspaceReviewsDir,
  getWorkspaceRoot,
  getWorkspaceStateDir,
  getWorkspaceStateDirForRoot,
} from "../src/runtime/state-paths.ts";
import { applyStoredTaskPatch } from "../src/runtime/patch-apply.ts";
import {
  buildBackgroundReadOnlyToolPlan,
  buildBackgroundResearchToolPlan,
  buildBackgroundReviewToolPlan,
  buildInspectionRetryGuidance,
  buildResearchPrompt,
  buildTaskPrompt,
  inspectResearchTools,
} from "../src/runtime/session-prompts.ts";
import {
  activateQueuedNativeResearchPromptsFromPayload,
  activateQueuedNativeResearchPrompt,
  appendNativeWebSearchTool,
  clearActiveNativeResearchPrompt,
  queueNativeResearchPrompt,
  shouldAppendNativeWebSearchTool,
  supportsNativeWebSearch,
} from "../src/runtime/native-tools.ts";
import { getCurrentSessionThinkingLevel } from "../src/runtime/thinking.ts";
import { captureTaskWorktreeDiff, cleanupTaskWorktree, createTaskWorktree } from "../src/runtime/worktree.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupWorkspace(cwd) {
  const stateDir = getWorkspaceStateDir(cwd);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
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

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function createGitRepo(prefix) {
  const repoDir = makeTempDir(prefix);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\n", "utf8");
  git(repoDir, ["add", ".gitignore", "tracked.txt"]);
  git(repoDir, ["commit", "-m", "initial"]);
  return repoDir;
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
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

function buildCompletedWriteTaskJob(repoDir, overrides = {}) {
  return {
    jobClass: "task",
    profile: "write",
    status: "completed",
    repoRoot: fs.realpathSync(repoDir),
    patchFile: undefined,
    worktreeBaseCommit: git(repoDir, ["rev-parse", "HEAD"]).trim(),
    ...overrides,
  };
}

function reviewRun(overrides = {}) {
  return {
    id: "review-default",
    kind: "review",
    repoRoot: "/tmp/workspace",
    branch: "main",
    targetLabel: "working tree diff",
    modelProvider: "openai-codex",
    modelId: "gpt-5.3-codex",
    createdAt: "2026-04-05T00:00:00.000Z",
    rawOutput: "",
    parseError: null,
    result: {
      verdict: "approve",
      summary: "synthetic review",
      findings: [],
      next_steps: [],
    },
    ...overrides,
  };
}

test("splitShellLikeArgs keeps quoted groups and escaped whitespace together", () => {
  assert.deepEqual(
    splitShellLikeArgs(String.raw`--model "openai-codex/gpt 5.4" path\ with\ spaces 'literal value' trailing\\`),
    ["--model", "openai-codex/gpt 5.4", "path with spaces", "literal value", "trailing\\"],
  );
});

test("splitLeadingOptionTokens only consumes the leading flag prefix and respects end-of-options", () => {
  assert.deepEqual(
    splitLeadingOptionTokens(
      ["--background", "--model", "openai-codex/gpt-5.3-codex", "investigate", "--write", "semantics"],
      ["--model"],
    ),
    {
      optionTokens: ["--background", "--model", "openai-codex/gpt-5.3-codex"],
      remainderTokens: ["investigate", "--write", "semantics"],
    },
  );

  assert.deepEqual(
    splitLeadingOptionTokens(["--readonly", "--", "--background", "literally"]),
    {
      optionTokens: ["--readonly"],
      remainderTokens: ["--background", "literally"],
    },
  );

  assert.deepEqual(
    splitLeadingOptionTokens(["--background", "--write", "fix", "auth", "refresh"], ["--model"]),
    {
      optionTokens: ["--background", "--write"],
      remainderTokens: ["fix", "auth", "refresh"],
    },
  );
});

test("task command options treat host flags as execution controls instead of task text", () => {
  assert.deepEqual(
    parseTaskCommandOptions('--readonly --model openai-codex/gpt-5.3-codex --thinking high inspect "--background semantics"'),
    {
      background: false,
      profile: "readonly",
      modelSpec: "openai-codex/gpt-5.3-codex",
      thinkingLevel: "high",
      request: "inspect --background semantics",
    },
  );

  assert.deepEqual(
    parseTaskCommandOptions("--background --write --thinking off fix auth refresh"),
    {
      background: true,
      profile: "write",
      modelSpec: undefined,
      thinkingLevel: "off",
      request: "fix auth refresh",
    },
  );

  assert.throws(
    () => parseTaskCommandOptions("--readonly --write fix auth refresh"),
    /either `--readonly` or `--write`/i,
  );
});

test("task prompt builder trims the request and preserves the Codex task contract", () => {
  const prompt = buildTaskPrompt("  investigate auth refresh races  ");
  assert.match(prompt, /<task>/);
  assert.match(prompt, /investigate auth refresh races/);
  assert.match(prompt, /<default_follow_through_policy>/);
  assert.match(prompt, /<verification_loop>/);
  assert.match(prompt, /Keep communication concise and factual\./);
});

test("task prompt builder can force a read-only task mode", () => {
  const prompt = buildTaskPrompt("draft a fix plan", ["read", "grep"], { readOnly: true });
  assert.match(prompt, /Stay read-only in this turn/);
  assert.match(prompt, /Do not edit files, run mutation commands, or change repository state in this turn\./);
  assert.match(prompt, /Return diagnosis, a concrete patch plan, or an explicit proposed diff instead of applying changes\./);
  assert.doesNotMatch(prompt, /If the request implies implementation, complete the implementation/);
});

test("task prompt builder can frame an isolated background write worker", () => {
  const prompt = buildTaskPrompt("implement retry logic", ["read", "edit", "write"], { backgroundWrite: true });
  assert.match(prompt, /detached write-capable worker running inside an isolated git worktree/i);
  assert.match(prompt, /Apply code changes only inside the isolated worktree for this job\./);
  assert.match(prompt, /Shell execution is intentionally unavailable in this worker profile/i);
});

test("task prompt builder adapts inspection guidance to the active tool set", () => {
  const prompt = buildTaskPrompt("inspect the repo", ["bash", "read"]);
  assert.match(prompt, /Prefer the active PI read-only inspection tools \(`read`\) for repository inspection\./);
  assert.doesNotMatch(prompt, /`find`, `ls`, `grep`, `read`/);
});

test("task prompt builder advertises active web tools when they are available", () => {
  const prompt = buildTaskPrompt("verify current docs", ["read", "bash", "web_search"], {
    readOnly: true,
    activeWebTools: ["web_search", "fetch_content"],
  });
  assert.match(prompt, /Active web tools are available in this session: fetch_content, web_search\./);
  assert.match(prompt, /Use them when the request requires external verification, official documentation, or current ecosystem checks\./);
});

test("research prompt builder adapts to active and inactive research tools", () => {
  const prompt = buildResearchPrompt("compare PI and Codex", {
    nativeWebSearchAvailable: false,
    activeWebTools: ["web_search", "fetch_content"],
    inactiveAvailableWebTools: ["code_search"],
    activeLocalEvidenceTools: ["find", "read"],
    activeMutationTools: ["edit"],
  });

  assert.match(prompt, /User request:\ncompare PI and Codex/);
  assert.match(prompt, /Active web research tools: fetch_content, web_search/);
  assert.match(prompt, /Installed but inactive web research tools: code_search/);
  assert.match(prompt, /Active mutation tools present but off-limits/);
  assert.match(prompt, /Use `web_search` for discovery and current-landscape checks\./);
  assert.match(prompt, /Use `fetch_content` to ground claims in the original page, repository, PDF, or video\./);
});

test("research prompt builder clearly states when live web verification is unavailable", () => {
  const prompt = buildResearchPrompt("summarize local architecture", {
    nativeWebSearchAvailable: false,
    activeWebTools: [],
    inactiveAvailableWebTools: ["web_search"],
    activeLocalEvidenceTools: ["find", "grep", "read"],
    activeMutationTools: [],
  });

  assert.match(prompt, /No active web research tools are available in this session\./);
  assert.match(prompt, /Some web-capable tools are installed but currently inactive/);
  assert.match(prompt, /Stay grounded in the local repository and explicitly call out where live web verification is unavailable\./);
});

test("research prompt builder falls back to bash when discovery builtins are inactive", () => {
  const prompt = buildResearchPrompt("inspect background semantics", {
    nativeWebSearchAvailable: false,
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    activeLocalEvidenceTools: ["bash", "read"],
    activeMutationTools: [],
  });

  assert.match(prompt, /Prefer the active PI read-only inspection tools \(`read`\) for repository inspection\./);
  assert.doesNotMatch(prompt, /Prefer PI read-only tools \(`find`, `ls`, `grep`, `read`\) over `bash`/);
});

test("research prompt builder prefers native Codex web search when available", () => {
  const prompt = buildResearchPrompt("check current npm version", {
    nativeWebSearchAvailable: true,
    activeWebTools: ["fetch_content"],
    inactiveAvailableWebTools: ["web_search"],
    activeLocalEvidenceTools: ["find", "read"],
    activeMutationTools: [],
  });

  assert.match(prompt, /Native Codex web search: enabled/);
  assert.match(prompt, /prefer it by default for current external facts/i);
  assert.match(prompt, /If the request is clearly about current external facts or ecosystem state, do not spend turns on local inspection before using web search\./);
  assert.match(prompt, /Do not use `bash` network clients or ad hoc HTTP scripts .* as a substitute for native Codex web search/i);
  assert.match(prompt, /Keep local evidence gathering on the active PI read-only tools shown above instead of reaching for shell-based web lookups\./);
  assert.doesNotMatch(prompt, /Use `bash` only for local repository inspection or runtime validation, not for external fact gathering when native web search is enabled\./);
  assert.match(prompt, /Use the active extension web tools only when they add something native web search does not/i);
  assert.doesNotMatch(prompt, /Inspect the local repository before making assumptions\./);
  assert.doesNotMatch(prompt, /No active web research tools are available in this session\./);
});

test("research tool inspection hides bash when native Codex web search is available", () => {
  const snapshot = inspectResearchTools(
    {
      getActiveTools() {
        return ["read", "bash", "grep", "edit"];
      },
      getAllTools() {
        return [
          { name: "read", sourceInfo: { source: "builtin" } },
          { name: "grep", sourceInfo: { source: "builtin" } },
          { name: "bash", sourceInfo: { source: "builtin" } },
          { name: "edit", sourceInfo: { source: "builtin" } },
        ];
      },
    },
    { nativeWebSearchAvailable: true },
  );

  assert.deepEqual(snapshot.activeLocalEvidenceTools, ["grep", "read"]);
  assert.deepEqual(snapshot.activeMutationTools, ["edit"]);
});

test("background research tool plan drops bash and extension web tools when native Codex web search is available", () => {
  const plan = buildBackgroundResearchToolPlan(
    {
      getActiveTools() {
        return ["read", "bash", "web_search"];
      },
      getAllTools() {
        return [
          { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
          { name: "grep", sourceInfo: { source: "builtin", path: "<builtin:grep>" } },
          { name: "find", sourceInfo: { source: "builtin", path: "<builtin:find>" } },
          { name: "ls", sourceInfo: { source: "builtin", path: "<builtin:ls>" } },
          { name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
          { name: "web_search", sourceInfo: { source: "extension", path: "/tmp/web-access/index.ts" } },
        ];
      },
    },
    { nativeWebSearchAvailable: true },
  );

  assert.deepEqual(plan.safeBuiltinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(plan.activatedWebTools, []);
  assert.deepEqual(plan.requestedToolNames, ["find", "grep", "ls", "read"]);
  assert.deepEqual(plan.extensionPaths, []);
  assert.deepEqual(plan.interactiveSnapshot.activeLocalEvidenceTools, ["read"]);
});

test("native web search helper only enables server-side web_search for supported OpenAI responses models", () => {
  assert.equal(
    supportsNativeWebSearch({ provider: "openai-codex", api: "openai-codex-responses" }),
    true,
  );
  assert.equal(
    supportsNativeWebSearch({ provider: "anthropic", api: "anthropic" }),
    false,
  );

  const injected = appendNativeWebSearchTool({ model: "x", tools: [{ type: "function", name: "read" }] });
  assert.deepEqual(injected, {
    model: "x",
    tools: [{ type: "function", name: "read" }, { type: "web_search" }],
  });
  assert.deepEqual(
    appendNativeWebSearchTool(injected),
    injected,
  );
});

test("native web search helper only activates for the matching queued research payload", () => {
  clearActiveNativeResearchPrompt();
  const prompt = "native-web-search smoke prompt";
  const matchingPayload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  };
  const unrelatedPayload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "something else" }],
      },
    ],
  };

  queueNativeResearchPrompt(prompt);
  assert.equal(shouldAppendNativeWebSearchTool(unrelatedPayload), false);
  assert.equal(shouldAppendNativeWebSearchTool(matchingPayload), true);
  assert.equal(activateQueuedNativeResearchPrompt(prompt), true);
  assert.equal(shouldAppendNativeWebSearchTool(matchingPayload), true);
  clearActiveNativeResearchPrompt(prompt);
  assert.equal(shouldAppendNativeWebSearchTool(matchingPayload), false);
});

test("native web search helper promotes queued prompts from provider payloads when before_agent_start is skipped", () => {
  clearActiveNativeResearchPrompt();
  const prompt = "native-web-search provider-payload promotion";
  const payload = {
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  };

  queueNativeResearchPrompt(prompt);
  assert.equal(shouldAppendNativeWebSearchTool(payload), true);
  assert.equal(activateQueuedNativeResearchPromptsFromPayload(payload), true);
  clearActiveNativeResearchPrompt(prompt);
  assert.equal(shouldAppendNativeWebSearchTool(payload), false);
});

test("background review tool plan keeps read-only git inspection builtins and activates available web extensions by default", () => {
  const plan = buildBackgroundReviewToolPlan({
    getActiveTools() {
      return ["read", "bash", "code_search", "edit", "custom_inspector"];
    },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "grep", sourceInfo: { source: "builtin" } },
        { name: "find", sourceInfo: { source: "builtin" } },
        { name: "ls", sourceInfo: { source: "builtin" } },
        { name: "edit", sourceInfo: { source: "builtin" } },
        { name: "code_search", sourceInfo: { source: "extension", path: "/tmp/pi-web-access.ts" } },
        { name: "custom_inspector", sourceInfo: { source: "extension", path: "/tmp/custom.ts" } },
      ];
    },
  });

  assert.deepEqual(plan.safeBuiltinTools, ["read", "grep", "find", "ls", "bash"]);
  assert.deepEqual(plan.requestedToolNames, ["bash", "code_search", "find", "grep", "ls", "read"]);
  assert.deepEqual(plan.extensionPaths, ["/tmp/pi-web-access.ts"]);
});

test("background readonly workers do not auto-activate heuristic extension tools outside the known safe web set", () => {
  const plan = buildBackgroundReadOnlyToolPlan({
    getActiveTools() {
      return ["read"];
    },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "grep", sourceInfo: { source: "builtin" } },
        { name: "find", sourceInfo: { source: "builtin" } },
        { name: "ls", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "github_search", sourceInfo: { source: "extension", path: "/tmp/github-search.ts" } },
      ];
    },
  });

  assert.deepEqual(plan.activatedWebTools, []);
  assert.doesNotMatch(plan.requestedToolNames.join(","), /github_search/);
});

test("deep review synthesis builds adjacent evidence from the resolved repo root", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/review/review-runner.ts"), "utf8");
  assert.match(source, /buildAdjacentEvidenceFromMentalModelResults\(repoRoot, lensResults\)/);
  assert.match(source, /buildAdjacentEvidence\(repoRoot, draftParsed\.parsed\)/);
});

test("adjacent evidence path resolution stays inside the repository root", () => {
  const repoDir = makeTempDir("pi-codex-adjacent-evidence-");
  const outsideDir = makeTempDir("pi-codex-adjacent-evidence-outside-");
  const repoFile = path.join(repoDir, "inside.txt");
  const outsideFile = path.join(outsideDir, "outside.txt");
  const symlinkPath = path.join(repoDir, "escape-link.txt");

  try {
    fs.writeFileSync(repoFile, "inside\n", "utf8");
    fs.writeFileSync(outsideFile, "outside\n", "utf8");
    fs.symlinkSync(outsideFile, symlinkPath);

    assert.equal(resolveSafeAdjacentEvidencePath(repoDir, "inside.txt"), fs.realpathSync(repoFile));
    assert.equal(resolveSafeAdjacentEvidencePath(repoDir, "../outside.txt"), null);
    assert.equal(resolveSafeAdjacentEvidencePath(repoDir, "escape-link.txt"), null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("review inspection event bridge is installed once instead of registering per-run handlers", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/background/review-job.ts"), "utf8");
  assert.match(source, /const reviewTurnBridgeApis = new WeakSet<object>\(\)/);
  assert.match(source, /let foregroundReviewReadOnlyDepth = 0;/);
  assert.match(source, /export function isForegroundReviewReadOnlyActive\(\): boolean/);
  assert.match(source, /function activateForegroundReviewTurn\(pi: ExtensionAPI, record: PendingReviewTurnRecord\): void/);
  assert.match(source, /function ensureReviewTurnEventBridge\(pi: ExtensionAPI\)/);
  assert.match(source, /Accepted turn_start fallback without matching before_agent_start\./);
  assert.match(source, /Accepted turn_end fallback without matching before_agent_start\/turn_start\./);
  assert.match(source, /Accepted agent_end fallback without matching turn_end\./);
  assert.match(source, /setImmediate\(\(\) => \{\s*process\.exit\(1\);/);
  assert.match(source, /Armed foreground review inspection before dispatch\./);
  assert.match(source, /record\.previousToolNames = Array\.from\(new Set\(pi\.getActiveTools\(\)\)\)/);
  assert.match(source, /pi\.setActiveTools\(record\.desiredActiveToolNames\)/);
  assert.match(source, /pi\.on\("turn_start", async \(event\) =>/);
  assert.match(source, /pi\.on\("agent_end", async \(event\) =>/);
  assert.match(source, /if \(!record\.matchedAgentStart\) \{/);
  assert.match(source, /record\.assignedTurnIndex = event\.turnIndex;/);
  assert.match(source, /record\.assignedTurnIndex == null/);
  assert.match(source, /event\.turnIndex !== record\.assignedTurnIndex/);
  assert.match(source, /pendingReviewTurns\.push\(record\)/);
  assert.match(source, /removePendingReviewTurn\(pi, record\)/);
  assert.match(source, /ctx\.abort\(\);/);
});

test("background readonly task plan keeps bash and available web tools in the detached child surface", () => {
  const plan = buildBackgroundReadOnlyToolPlan({
    getActiveTools() {
      return ["read", "edit"];
    },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "grep", sourceInfo: { source: "builtin" } },
        { name: "find", sourceInfo: { source: "builtin" } },
        { name: "ls", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "edit", sourceInfo: { source: "builtin" } },
        { name: "web_search", sourceInfo: { source: "extension", path: "/tmp/pi-web-access.ts" } },
      ];
    },
  });

  assert.deepEqual(plan.safeBuiltinTools, ["read", "grep", "find", "ls", "bash"]);
  assert.deepEqual(plan.activatedWebTools, ["web_search"]);
  assert.deepEqual(plan.requestedToolNames, ["bash", "find", "grep", "ls", "read", "web_search"]);
});

test("inspection retry guidance only suggests active tools and falls back cleanly", () => {
  assert.deepEqual(buildInspectionRetryGuidance(["read", "bash"], true), [
    "Use the appropriate PI read-only tool instead, such as `read`.",
  ]);

  assert.deepEqual(buildInspectionRetryGuidance(["bash"], true), [
    "No PI read-only inspection builtins are active right now beyond `bash`.",
    "If you still need repository inspection, use read-only `bash` commands instead of retrying the same blocked step.",
  ]);

  assert.deepEqual(buildInspectionRetryGuidance([], false), [
    "No PI repository-inspection tools are active right now.",
    "State exactly which missing tool prevents grounded inspection instead of retrying the same blocked step.",
  ]);
});

test("read-only shell classification allows compound git inspection but still blocks mutation patterns", () => {
  assert.equal(isLikelyReadOnlyShellCommand("git status --short && git diff -- app/models/user.rb"), true);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb | sed -n '1,120p'"), true);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb | sed -n -e '1,120p' -e '140,180p'"), true);
  assert.equal(isLikelyReadOnlyShellCommand("git branch -vv ; git merge-base HEAD origin/main"), true);
  assert.equal(isLikelyReadOnlyShellCommand("git remote show origin"), true);
  assert.equal(isLikelyReadOnlyShellCommand("find . -type f -name '*.rb'"), true);

  assert.equal(isLikelyReadOnlyShellCommand("cat package.json"), false);
  assert.equal(isLikelyReadOnlyShellCommand("grep foo package.json"), false);
  assert.equal(isLikelyReadOnlyShellCommand("ls -la"), false);
  assert.equal(isLikelyReadOnlyShellCommand("sort package.json"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb > /tmp/out.txt"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git diff --output=/tmp/out.txt"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git diff -- app/models/user.rb | tee /tmp/out.txt"), false);
  assert.equal(isLikelyReadOnlyShellCommand("find . -delete"), false);
  assert.equal(isLikelyReadOnlyShellCommand("find . -exec touch /tmp/out \\;"), false);
  assert.equal(isLikelyReadOnlyShellCommand("sort -o /tmp/out package.json"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git status --short && rm -f tmp/out"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb && $(touch /tmp/pwned)"), false);
  assert.equal(isLikelyReadOnlyShellCommand("cat <(touch /tmp/pwned)"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb | sed -n 'w /tmp/out'"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git show HEAD:app/models/user.rb | sed -n '/needle/p'"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git branch topic"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git branch -D topic"), false);
  assert.equal(isLikelyReadOnlyShellCommand("git remote remove origin"), false);
});

test("readonly scope checks keep builtin inspection tools inside the repository root", () => {
  const scopeRoot = "/tmp/repo";
  assert.equal(findReadOnlyScopeViolation("read", { path: "app/models/user.rb" }, scopeRoot), null);
  assert.equal(findReadOnlyScopeViolation("find", { path: "./config" }, scopeRoot), null);
  assert.equal(findReadOnlyScopeViolation("grep", { path: "../shared" }, scopeRoot), "../shared");
  assert.equal(findReadOnlyScopeViolation("ls", { path: "/tmp/repo/spec" }, scopeRoot), null);
  assert.equal(findReadOnlyScopeViolation("find", { path: "/Users/go" }, scopeRoot), "/Users/go");
  assert.equal(findReadOnlyScopeViolation("read", { path: "../../shared/file.ts" }, scopeRoot, "/tmp/repo/packages/app"), null);
  assert.equal(findReadOnlyScopeViolation("ls", { path: "../outside" }, scopeRoot, "/tmp/repo/packages/app"), null);
});

test("readonly scope checks keep bash inspection commands inside the repository root", () => {
  const scopeRoot = "/tmp/repo";
  assert.equal(findReadOnlyScopeViolationInBashCommand("git status --short && git diff -- app/models/user.rb", scopeRoot), null);
  assert.equal(findReadOnlyScopeViolationInBashCommand("git diff -- /tmp/repo/app/models/user.rb", scopeRoot), null);
  assert.equal(findReadOnlyScopeViolationInBashCommand("git diff -- /Users/go", scopeRoot), "/Users/go");
  assert.equal(findReadOnlyScopeViolationInBashCommand("git diff -- a/../../other-repo/file.txt", scopeRoot), "a/../../other-repo/file.txt");
  assert.equal(findReadOnlyScopeViolationInBashCommand("find . -type f -name '*.rb'", scopeRoot), null);
  assert.equal(findReadOnlyScopeViolationInBashCommand("find -H /Users/go -type f -name '*.rb'", scopeRoot), "/Users/go");
  assert.equal(findReadOnlyScopeViolationInBashCommand("find /Users/go -type f -name '*.rb'", scopeRoot), "/Users/go");
  assert.equal(findReadOnlyScopeViolationInBashCommand("find subdir/../../../../etc -type f", scopeRoot), "subdir/../../../../etc");
  assert.equal(findReadOnlyScopeViolationInBashCommand("sed -n '1,10p' /Users/go/file.txt", scopeRoot), "/Users/go/file.txt");
  assert.equal(findReadOnlyScopeViolationInBashCommand("find ../other-package -type f", scopeRoot, "/tmp/repo/packages/app"), null);
});

test("headless readonly bash whitelist helper records safe exact commands", () => {
  const cwd = makeTempDir("pi-codex-bash-whitelist-");
  try {
    const command = "git status --short && git diff -- app/models/user.rb";
    assert.equal(ensureHeadlessReadOnlyBashWhitelisted(cwd, command), true);
    const whitelistPath = path.join(cwd, ".pi", "bash-confirm-whitelist.json");
    const stored = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
    assert.equal(stored.version, 2);
    assert.equal(stored.entries.some((entry) => entry.type === "exact" && entry.value === command), true);
    assert.equal(ensureHeadlessReadOnlyBashWhitelisted(cwd, command), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("protected path matching handles both file and directory-style entries", () => {
  assert.equal(findProtectedPathMatch(".env", [".env", ".git/"]), ".env");
  assert.equal(findProtectedPathMatch("config/.env", [".env", ".git/"]), ".env");
  assert.equal(findProtectedPathMatch(".git/config", [".git/"]), ".git/");
  assert.equal(findProtectedPathMatch("repo/.git/hooks/pre-commit", [".git/"]), ".git/");
  assert.equal(findProtectedPathMatch("src/index.ts", [".env", ".git/"]), null);
});

test("protected bash path detection allows read-only inspection but blocks mutations", () => {
  const protectedPaths = [".env", ".git/"];

  assert.equal(findProtectedPathInBashCommand("cat .env", protectedPaths), ".env");
  assert.equal(findProtectedPathInBashCommand("echo .env", protectedPaths), null);
  assert.equal(findProtectedPathInBashCommand("git status --short", protectedPaths), null);
  assert.equal(findProtectedPathInBashCommand("git status --short && git diff -- .env", protectedPaths), null);
  assert.equal(findProtectedPathInBashCommand("git show HEAD:.env | sed -n '1,40p'", protectedPaths), null);

  assert.equal(
    findProtectedPathInBashCommand(String.raw`python3 -c "from pathlib import Path; Path('.env').write_text('x')"`, protectedPaths),
    ".env",
  );
  assert.equal(findProtectedPathInBashCommand("git restore .env", protectedPaths), ".env");
  assert.equal(findProtectedPathInBashCommand("cat .env && rm .env", protectedPaths), ".env");
  assert.equal(findProtectedPathInBashCommand("rm .git/config", protectedPaths), ".git/");
});

test("review store resolves latest, exact, prefix, and ambiguous references", () => {
  const cwd = makeTempDir("pi-codex-review-store-");
  try {
    storeReviewRun(cwd, reviewRun({ id: "review-ambig-alpha", createdAt: "2026-04-05T00:00:00.000Z" }), 50);
    storeReviewRun(cwd, reviewRun({ id: "review-ambig-beta", createdAt: "2026-04-05T01:00:00.000Z" }), 50);

    const runs = listStoredReviews(cwd);
    assert.deepEqual(runs.map((run) => run.id), ["review-ambig-beta", "review-ambig-alpha"]);
    assert.equal(findStoredReview(cwd)?.id, "review-ambig-beta");
    assert.equal(findStoredReview(cwd, "review-ambig-alpha")?.id, "review-ambig-alpha");
    assert.equal(findStoredReview(cwd, "review-ambig-a")?.id, "review-ambig-alpha");
    assert.throws(() => findStoredReview(cwd, "review-ambig-"), /ambiguous/i);
    assert.equal(findStoredReview(cwd, "review-missing"), null);
  } finally {
    cleanupWorkspace(cwd);
  }
});

test("review store orders overlapping reviews by completed result time when available", () => {
  const cwd = makeTempDir("pi-codex-review-order-");
  try {
    storeReviewRun(
      cwd,
      reviewRun({
        id: "review-started-later-finished-earlier",
        createdAt: "2026-04-06T10:05:00.000Z",
        startedAt: "2026-04-06T10:05:00.000Z",
        completedAt: "2026-04-06T10:05:10.000Z",
      }),
      50,
    );
    storeReviewRun(
      cwd,
      reviewRun({
        id: "review-started-earlier-finished-later",
        createdAt: "2026-04-06T10:00:00.000Z",
        startedAt: "2026-04-06T10:00:00.000Z",
        completedAt: "2026-04-06T10:06:00.000Z",
      }),
      50,
    );

    const runs = listStoredReviews(cwd);
    assert.deepEqual(runs.map((run) => run.id), [
      "review-started-earlier-finished-later",
      "review-started-later-finished-earlier",
    ]);
    assert.equal(findStoredReview(cwd)?.id, "review-started-earlier-finished-later");
    assert.equal(storedReviewSortKey(runs[0]), "2026-04-06T10:06:00.000Z");
  } finally {
    cleanupWorkspace(cwd);
  }
});

test("review store prunes older runs and cleans zero-size stale artifacts", () => {
  const cwd = makeTempDir("pi-codex-review-prune-");
  const stateDir = getWorkspaceStateDir(cwd);
  try {
    const reviewDir = getWorkspaceReviewsDir(cwd);
    fs.writeFileSync(path.join(reviewDir, "empty.json"), "");

    storeReviewRun(cwd, reviewRun({ id: "review-old", createdAt: "2026-04-05T00:00:00.000Z" }), 2);
    storeReviewRun(cwd, reviewRun({ id: "review-mid", createdAt: "2026-04-05T01:00:00.000Z" }), 2);
    storeReviewRun(cwd, reviewRun({ id: "review-new", createdAt: "2026-04-05T02:00:00.000Z" }), 2);

    assert.deepEqual(listStoredReviews(cwd).map((run) => run.id), ["review-new", "review-mid"]);
    assert.equal(fs.existsSync(path.join(reviewDir, "review-old.json")), false);
    assert.equal(fs.existsSync(path.join(reviewDir, "empty.json")), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("large branch review contexts omit the full diff body and keep the change map", () => {
  const repoDir = createGitRepo("pi-codex-large-branch-");
  try {
    git(repoDir, ["checkout", "-b", "feature/large-review"]);
    const hugeBody = `${"A".repeat(1_250_000)}\n`;
    fs.writeFileSync(path.join(repoDir, "huge.txt"), hugeBody, "utf8");
    git(repoDir, ["add", "huge.txt"]);
    git(repoDir, ["commit", "-m", "large branch change"]);

    const context = collectReviewContext(repoDir, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.match(context.content, /## Commit Log/);
    assert.match(context.content, /## Diff Stat/);
    assert.match(context.content, /## Changed Files/);
    assert.match(context.content, /## Branch Diff/);
    assert.match(context.content, /Branch diff omitted from inline review context because it is too large/i);
    assert.match(context.content, /huge\.txt/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("small branch review contexts still inline the branch diff", () => {
  const repoDir = createGitRepo("pi-codex-small-branch-");
  try {
    git(repoDir, ["checkout", "-b", "feature/small-review"]);
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\nsmall change\n", "utf8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "small branch change"]);

    const context = collectReviewContext(repoDir, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.match(context.content, /## Branch Diff/);
    assert.match(context.content, /\+small change/);
    assert.doesNotMatch(context.content, /Branch diff omitted from inline review context because it is too large/i);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("branch review contexts still inline broad changes when each file is tiny", () => {
  const repoDir = createGitRepo("pi-codex-many-small-branch-");
  try {
    git(repoDir, ["checkout", "-b", "feature/many-small-files"]);
    for (let index = 0; index < 80; index += 1) {
      fs.writeFileSync(path.join(repoDir, `small-${index}.txt`), `line ${index}\n`, "utf8");
    }
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "many tiny files"]);

    const context = collectReviewContext(repoDir, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.match(context.content, /## Branch Diff/);
    assert.match(context.content, /\+\+\+ b\/small-79\.txt/);
    assert.doesNotMatch(context.content, /Branch diff omitted from inline review context because it is too large/i);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("branch review contexts handle newline-containing filenames without corrupting the batch size estimate", () => {
  const repoDir = createGitRepo("pi-codex-newline-path-");
  try {
    git(repoDir, ["checkout", "-b", "feature/newline-path"]);
    fs.writeFileSync(path.join(repoDir, "safe.txt"), "base\n", "utf8");
    git(repoDir, ["add", "safe.txt"]);
    git(repoDir, ["commit", "-m", "baseline file"]);

    const newlinePath = "tiny\npath.txt";
    fs.writeFileSync(path.join(repoDir, newlinePath), "tiny change\n", "utf8");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "add newline path"]);

    const context = collectReviewContext(repoDir, {
      mode: "branch",
      label: "branch diff against main",
      baseRef: "main",
      explicit: true,
    });

    assert.match(context.content, /## Branch Diff/);
    assert.doesNotMatch(context.content, /Branch diff omitted from inline review context because it is too large/i);
    assert.match(context.content, /\+tiny change/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("workspace state dir is stable across symlinked roots", () => {
  const realRoot = makeTempDir("pi-codex-workspace-real-");
  const symlinkBase = makeTempDir("pi-codex-workspace-link-");
  const symlinkPath = path.join(symlinkBase, "linked-workspace");

  try {
    fs.symlinkSync(realRoot, symlinkPath, "dir");

    const realStateDir = getWorkspaceStateDirForRoot(realRoot);
    const symlinkStateDir = getWorkspaceStateDirForRoot(symlinkPath);

    assert.equal(realStateDir, symlinkStateDir);
  } finally {
    fs.rmSync(getWorkspaceStateDirForRoot(realRoot), { recursive: true, force: true });
    fs.rmSync(symlinkBase, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

test("codex state follows PI_CODING_AGENT_DIR when it is set", () => {
  const agentRoot = makeTempDir("pi-codex-agent-root-");
  const previous = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentRoot;
    const codexHome = getCodexHome();
    assert.equal(codexHome, path.join(agentRoot, "codex"));
    assert.equal(fs.existsSync(codexHome), true);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    fs.rmSync(path.join(agentRoot, "codex"), { recursive: true, force: true });
    fs.rmSync(agentRoot, { recursive: true, force: true });
  }
});

test("non-git workspaces use the cwd as the workspace root and still create jobs directories", () => {
  const cwd = makeTempDir("pi-codex-non-git-");
  try {
    assert.equal(getWorkspaceRoot(cwd), cwd);

    const jobsDir = getWorkspaceJobsDir(cwd);
    assert.equal(fs.existsSync(jobsDir), true);
    assert.match(jobsDir, /jobs$/);

    const jobsDirForRoot = getWorkspaceJobsDirForRoot(cwd);
    assert.equal(fs.existsSync(jobsDirForRoot), true);
    assert.equal(jobsDirForRoot, jobsDir);
  } finally {
    cleanupWorkspace(cwd);
  }
});

test("task worktree helper preserves cwd, links node_modules, captures a patch, and cleans up", () => {
  const repoDir = createGitRepo("pi-codex-worktree-helper-");
  const nestedCwd = path.join(repoDir, "packages", "app");
  fs.mkdirSync(nestedCwd, { recursive: true });
  fs.mkdirSync(path.join(repoDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "node_modules", "marker.txt"), "linked\n", "utf8");

  try {
    const runId = `unit-write-${Date.now().toString(36)}`;
    const setup = createTaskWorktree(nestedCwd, runId);
    assert.equal(fs.realpathSync(setup.repoRoot), fs.realpathSync(repoDir));
    assert.equal(setup.agentCwd, path.join(setup.worktreePath, "packages", "app"));
    assert.ok(setup.syntheticPaths.includes("node_modules"));
    assert.equal(fs.existsSync(path.join(setup.worktreePath, "tracked.txt")), true);
    assert.equal(fs.lstatSync(path.join(setup.worktreePath, "node_modules")).isSymbolicLink(), true);

    fs.writeFileSync(path.join(setup.worktreePath, "tracked.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(setup.worktreePath, "new-file.ts"), "export const added = true;\n", "utf8");

    const patchFile = path.join(repoDir, "artifacts.patch");
    const diff = captureTaskWorktreeDiff(setup, patchFile);
    assert.equal(fs.existsSync(patchFile), true);
    assert.equal(diff.patchFile, patchFile);
    assert.ok(diff.filesChanged >= 2);
    assert.match(diff.diffStat, /tracked\.txt/);
    assert.match(fs.readFileSync(patchFile, "utf8"), /new-file\.ts/);
    assert.equal(fs.existsSync(path.join(setup.worktreePath, "node_modules")), false);

    cleanupTaskWorktree(setup);
    assert.equal(fs.existsSync(setup.worktreePath), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("task worktree helper fails closed on dirty repositories", () => {
  const repoDir = createGitRepo("pi-codex-worktree-dirty-");
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf8");

  try {
    assert.throws(() => createTaskWorktree(repoDir, `dirty-write-${Date.now().toString(36)}`), /clean git working tree/i);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("stored background write-task patches can be applied back to a clean live repository", () => {
  const repoDir = createGitRepo("pi-codex-apply-patch-");
  const setup = createTaskWorktree(repoDir, `apply-${Date.now().toString(36)}`);
  const patchDir = makeTempDir("pi-codex-apply-artifacts-");

  try {
    fs.writeFileSync(path.join(setup.worktreePath, "tracked.txt"), "changed\n", "utf8");
    const patchFile = path.join(patchDir, "task.patch");
    const diff = captureTaskWorktreeDiff(setup, patchFile);
    cleanupTaskWorktree(setup);

    const result = applyStoredTaskPatch(
      repoDir,
      buildCompletedWriteTaskJob(repoDir, {
        patchFile,
        worktreeBaseCommit: setup.baseCommit,
      }),
    );

    assert.equal(result.patchFile, patchFile);
    assert.match(result.diffStat, /tracked\.txt/);
    assert.equal(fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf8"), "changed\n");
    assert.match(diff.diffStat, /tracked\.txt/);
  } finally {
    try {
      cleanupTaskWorktree(setup);
    } catch {}
    fs.rmSync(patchDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("stored background write-task patches refuse to apply onto a dirty live repository", () => {
  const repoDir = createGitRepo("pi-codex-apply-dirty-");
  const setup = createTaskWorktree(repoDir, `apply-dirty-${Date.now().toString(36)}`);
  const patchDir = makeTempDir("pi-codex-apply-artifacts-");

  try {
    fs.writeFileSync(path.join(setup.worktreePath, "tracked.txt"), "changed\n", "utf8");
    const patchFile = path.join(patchDir, "task.patch");
    captureTaskWorktreeDiff(setup, patchFile);
    cleanupTaskWorktree(setup);
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf8");

    assert.throws(
      () =>
        applyStoredTaskPatch(
          repoDir,
          buildCompletedWriteTaskJob(repoDir, {
            patchFile,
            worktreeBaseCommit: setup.baseCommit,
          }),
        ),
      /clean git working tree/i,
    );
  } finally {
    try {
      cleanupTaskWorktree(setup);
    } catch {}
    fs.rmSync(patchDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("stored background write-task patches refuse to apply after the live repo head changes", () => {
  const repoDir = createGitRepo("pi-codex-apply-head-");
  const setup = createTaskWorktree(repoDir, `apply-head-${Date.now().toString(36)}`);
  const patchDir = makeTempDir("pi-codex-apply-artifacts-");

  try {
    fs.writeFileSync(path.join(setup.worktreePath, "tracked.txt"), "changed\n", "utf8");
    const patchFile = path.join(patchDir, "task.patch");
    captureTaskWorktreeDiff(setup, patchFile);
    cleanupTaskWorktree(setup);

    fs.writeFileSync(path.join(repoDir, "other.txt"), "later\n", "utf8");
    git(repoDir, ["add", "other.txt"]);
    git(repoDir, ["commit", "-m", "advance"]);

    assert.throws(
      () =>
        applyStoredTaskPatch(
          repoDir,
          buildCompletedWriteTaskJob(repoDir, {
            patchFile,
            worktreeBaseCommit: setup.baseCommit,
          }),
        ),
      /no longer matches the job base commit/i,
    );
  } finally {
    try {
      cleanupTaskWorktree(setup);
    } catch {}
    fs.rmSync(patchDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("registered commands expose useful argument completions and stop suggesting flags after free-form text starts", () => {
  const commands = new Map();

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    events: {
      emit() {},
    },
  });

  const reviewCommand = commands.get("codex:review");
  const mentalModelsCommand = commands.get("codex:adversarial_mental_models_review");
  const taskCommand = commands.get("codex:task");
  const researchCommand = commands.get("codex:research");
  const resultCommand = commands.get("codex:result");

  assert.equal(typeof reviewCommand?.getArgumentCompletions, "function");
  assert.equal(typeof mentalModelsCommand?.getArgumentCompletions, "function");
  assert.equal(typeof taskCommand?.getArgumentCompletions, "function");
  assert.equal(typeof researchCommand?.getArgumentCompletions, "function");
  assert.equal(typeof resultCommand?.getArgumentCompletions, "function");

  const reviewRootCompletions = reviewCommand.getArgumentCompletions("");
  assert.ok(reviewRootCompletions.some((item) => item.label === "--background"));
  assert.ok(reviewRootCompletions.some((item) => item.label === "--scope working-tree"));
  assert.ok(reviewRootCompletions.some((item) => item.label === "--thinking high"));

  const scopeValueCompletions = reviewCommand.getArgumentCompletions("--scope ");
  assert.deepEqual(
    scopeValueCompletions.map((item) => item.label),
    ["working-tree", "branch"],
  );

  const quotedBaseValueCompletions = reviewCommand.getArgumentCompletions('--base "orig');
  assert.ok(quotedBaseValueCompletions.some((item) => item.label === "origin/main"));

  const mentalModelsRootCompletions = mentalModelsCommand.getArgumentCompletions("");
  assert.ok(mentalModelsRootCompletions.some((item) => item.label === "--background"));
  assert.ok(mentalModelsRootCompletions.some((item) => item.label === "--thinking xhigh"));

  const taskRootCompletions = taskCommand.getArgumentCompletions("");
  assert.ok(taskRootCompletions.some((item) => item.label === "--readonly"));
  assert.ok(taskRootCompletions.some((item) => item.label === "--write"));
  assert.ok(taskRootCompletions.some((item) => item.label === "--background"));
  assert.ok(taskRootCompletions.some((item) => item.label === "--thinking xhigh"));
  assert.equal(taskCommand.getArgumentCompletions("diagnose auth refresh"), null);
  const taskThinkingValueCompletions = taskCommand.getArgumentCompletions("--thinking ");
  assert.ok(taskThinkingValueCompletions.some((item) => item.label === "off"));
  assert.ok(taskThinkingValueCompletions.some((item) => item.label === "xhigh"));

  const researchRootCompletions = researchCommand.getArgumentCompletions("");
  assert.ok(researchRootCompletions.some((item) => item.label === "--background"));
  assert.ok(researchRootCompletions.some((item) => item.label === "--thinking medium"));

  const resultRootCompletions = resultCommand.getArgumentCompletions("");
  assert.ok(resultRootCompletions.some((item) => item.label === "--last"));
});

test("current session thinking prefers session context over extension api fallback", () => {
  const level = getCurrentSessionThinkingLevel(
    {
      getThinkingLevel() {
        return "low";
      },
    },
    {
      sessionManager: {
        buildSessionContext() {
          return { messages: [], thinkingLevel: "xhigh", model: null };
        },
      },
    },
  );

  assert.equal(level, "xhigh");
});

test("review abort helper preserves explicit abort reasons", () => {
  const timeoutController = new AbortController();
  timeoutController.abort(new Error("Background review exceeded 720s without reaching a terminal review result."));
  assert.match(reviewAbortError(timeoutController.signal).message, /exceeded 720s/i);

  const cancelController = new AbortController();
  cancelController.abort("Background review cancellation requested.");
  assert.equal(reviewAbortError(cancelController.signal).message, "Background review cancellation requested.");

  assert.equal(reviewAbortError(undefined).message, "Review cancelled.");
});

test("structured review prompts cap oversized inspection notes and candidate review payloads", () => {
  const oversizedInspectionNotes = `## Notes\n\n${"A".repeat(20_000)}`;
  const oversizedCandidateReview = renderCandidateReviewForSynthesis(
    `Summary\n\n${"B".repeat(20_000)}`,
    null,
    "invalid json",
  );

  const draftPrompt = buildStructuredReviewPrompt("review", "working tree diff", undefined, "## Git Status\n\nM app/models/user.rb", oversizedInspectionNotes);
  const synthesisPrompt = buildStructuredReviewSynthesisPrompt(
    "adversarial-review",
    "working tree diff",
    undefined,
    "## Git Status\n\nM app/models/user.rb",
    oversizedCandidateReview,
    `### app/models/user.rb:1-20\n${"C".repeat(20_000)}`,
    oversizedInspectionNotes,
  );

  assert.match(draftPrompt, /\[Inspection notes truncated after 12000 characters\.\]/);
  assert.match(synthesisPrompt, /\[Candidate review truncated after 10000 characters\.\]/);
});

test("inline research enables native Codex web search through the provider payload for supported models", async () => {
  const commands = new Map();
  const handlers = new Map();
  const sentMessages = [];

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage(content) {
      sentMessages.push(String(content));
    },
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return "medium";
    },
    setThinkingLevel() {},
    events: {
      emit() {},
    },
  });

  const researchCommand = commands.get("codex:research");
  const beforeAgentStart = handlers.get("before_agent_start");
  const beforeProviderRequest = handlers.get("before_provider_request");
  const agentEnd = handlers.get("agent_end");
  assert.equal(typeof researchCommand?.handler, "function");
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof beforeProviderRequest, "function");
  assert.equal(typeof agentEnd, "function");

  await researchCommand.handler("check current npm version", {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.3-codex" },
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    isIdle() {
      return true;
    },
    hasPendingMessages() {
      return false;
    },
    shutdown() {},
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: "medium", model: null };
      },
    },
    ui: {
      notify() {},
      setStatus() {},
      theme: { fg: (_name, value) => value },
    },
  });

  assert.equal(sentMessages.length, 1);
  const prompt = sentMessages[0];
  assert.match(prompt, /Native Codex web search: enabled/);

  await beforeAgentStart({ prompt });
  const matchingPayload = {
    model: "x",
    tools: [],
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  };
  const payload = await beforeProviderRequest({ payload: matchingPayload });
  assert.deepEqual(payload, { ...matchingPayload, tools: [{ type: "web_search" }] });

  await agentEnd({ messages: [] });
  const afterEnd = await beforeProviderRequest({ payload: matchingPayload });
  assert.equal(afterEnd, undefined);
});

test("inline task --thinking temporarily overrides the session effort for the injected turn only", async () => {
  const commands = new Map();
  const handlers = new Map();
  const reports = [];
  const sentMessages = [];
  const thinkingTransitions = [];
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage(message, options) {
      reports.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    },
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
      thinkingTransitions.push(level);
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  assert.equal(currentThinking, "xhigh");
  assert.equal(sentMessages.length, 1);
  assert.match(String(reports.at(-1)?.message?.content ?? ""), /temporarily use `xhigh` for this turn only/i);

  const turnStart = handlers.get("turn_start");
  const turnEnd = handlers.get("turn_end");
  assert.equal(typeof turnStart, "function");
  assert.equal(typeof turnEnd, "function");
  await turnStart({ turnIndex: 7 });
  await turnEnd({ turnIndex: 7 });

  assert.equal(currentThinking, "medium");
  assert.deepEqual(thinkingTransitions, ["xhigh", "medium"]);
});

test("inline task --thinking restore ignores unrelated turn_end events and restores only on the matching turn", async () => {
  const commands = new Map();
  const handlers = new Map();
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  const turnStart = handlers.get("turn_start");
  const turnEnd = handlers.get("turn_end");
  assert.equal(typeof turnStart, "function");
  assert.equal(typeof turnEnd, "function");

  await turnStart({ turnIndex: 3 });
  await turnEnd({ turnIndex: 2 });
  assert.equal(currentThinking, "xhigh");

  await turnEnd({ turnIndex: 3 });
  assert.equal(currentThinking, "medium");
});

test("inline task --thinking restores on turn_end even when turn lifecycle events have no usable index", async () => {
  const commands = new Map();
  const handlers = new Map();
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  const turnEnd = handlers.get("turn_end");
  assert.equal(typeof turnEnd, "function");
  assert.equal(currentThinking, "xhigh");

  await turnEnd({});
  assert.equal(currentThinking, "medium");
});

test("inline task --thinking does not overwrite a later manual thinking-level change", async () => {
  const commands = new Map();
  const handlers = new Map();
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  const turnStart = handlers.get("turn_start");
  const turnEnd = handlers.get("turn_end");
  assert.equal(typeof turnStart, "function");
  assert.equal(typeof turnEnd, "function");

  await turnStart({ turnIndex: 5 });
  currentThinking = "low";
  await turnEnd({ turnIndex: 5 });
  assert.equal(currentThinking, "low");
});

test("inline task --thinking stale watchdog does not restore while the agent is still running", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, _ms) => {
    const handle = { unref() {}, fn };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const index = scheduled.indexOf(handle);
    if (index >= 0) {
      scheduled.splice(index, 1);
    }
  };

  try {
    const commands = new Map();
    const handlers = new Map();
    let currentThinking = "medium";

    registerCodexExtension({
      registerCommand(name, options) {
        commands.set(name, options);
      },
      on(name, handler) {
        handlers.set(name, handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
      getActiveTools() {
        return ["read", "grep", "find", "ls"];
      },
      getAllTools() {
        return [];
      },
      getThinkingLevel() {
        return currentThinking;
      },
      setThinkingLevel(level) {
        currentThinking = level;
      },
      events: {
        emit() {},
      },
    });

    const taskCommand = commands.get("codex:task");
    assert.equal(typeof taskCommand?.handler, "function");

    await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
      cwd: process.cwd(),
      hasUI: false,
      model: undefined,
      modelRegistry: {},
      signal: undefined,
      abort() {},
      compact() {},
      getContextUsage() {
        return undefined;
      },
      getSystemPrompt() {
        return "";
      },
      hasPendingMessages() {
        return false;
      },
      isIdle() {
        return true;
      },
      sessionManager: {
        buildSessionContext() {
          return { messages: [], thinkingLevel: currentThinking, model: null };
        },
      },
      shutdown() {},
      ui: {
        notify() {},
        setStatus() {},
        theme: {
          fg(_token, value) {
            return value;
          },
          bg(_token, value) {
            return value;
          },
          bold(value) {
            return value;
          },
        },
      },
    });

    const agentStart = handlers.get("agent_start");
    const turnStart = handlers.get("turn_start");
    const agentEnd = handlers.get("agent_end");
    assert.equal(typeof agentStart, "function");
    assert.equal(typeof turnStart, "function");
    assert.equal(typeof agentEnd, "function");
    assert.equal(scheduled.length, 1);

    await agentStart({});
    await turnStart({ turnIndex: 9 });
    scheduled[0].fn();
    assert.equal(currentThinking, "xhigh");

    await agentEnd({});
    assert.equal(currentThinking, "medium");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("inline task --thinking restores on agent_end if turn lifecycle events never arrive", async () => {
  const commands = new Map();
  const handlers = new Map();
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  await taskCommand.handler("--readonly --thinking xhigh diagnose auth refresh", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  const agentEnd = handlers.get("agent_end");
  assert.equal(typeof agentEnd, "function");
  assert.equal(currentThinking, "xhigh");

  await agentEnd({});
  assert.equal(currentThinking, "medium");
});

test("inline task --thinking rejects a second override while the first inline override is still pending", async () => {
  const commands = new Map();
  const reports = [];
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on() {},
    registerMessageRenderer() {},
    sendMessage(message, options) {
      reports.push({ message, options });
    },
    sendUserMessage() {},
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const taskCommand = commands.get("codex:task");
  assert.equal(typeof taskCommand?.handler, "function");

  const commandContext = {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  };

  await taskCommand.handler("--readonly --thinking xhigh first task", commandContext);
  assert.equal(currentThinking, "xhigh");

  await taskCommand.handler("--readonly --thinking high second task", commandContext);
  assert.equal(currentThinking, "xhigh");
  assert.match(String(reports.at(-1)?.message?.content ?? ""), /Another inline `\/codex:task --thinking/i);
});

test("inline research --thinking is rejected while another turn is already running", async () => {
  const commands = new Map();
  const reports = [];
  let currentThinking = "medium";

  registerCodexExtension({
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on() {},
    registerMessageRenderer() {},
    sendMessage(message, options) {
      reports.push({ message, options });
    },
    sendUserMessage() {
      throw new Error("sendUserMessage should not be called when inline thinking is rejected");
    },
    getActiveTools() {
      return ["read", "grep", "find", "ls"];
    },
    getAllTools() {
      return [];
    },
    getThinkingLevel() {
      return currentThinking;
    },
    setThinkingLevel(level) {
      currentThinking = level;
    },
    events: {
      emit() {},
    },
  });

  const researchCommand = commands.get("codex:research");
  assert.equal(typeof researchCommand?.handler, "function");

  await researchCommand.handler("--thinking high inspect the repo", {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    signal: undefined,
    abort() {},
    compact() {},
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return "";
    },
    hasPendingMessages() {
      return true;
    },
    isIdle() {
      return false;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [], thinkingLevel: currentThinking, model: null };
      },
    },
    shutdown() {},
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg(_token, value) {
          return value;
        },
        bg(_token, value) {
          return value;
        },
        bold(value) {
          return value;
        },
      },
    },
  });

  assert.equal(currentThinking, "medium");
  assert.match(String(reports.at(-1)?.message?.content ?? ""), /only works when the agent is idle/i);
});

test("input fallback routes /codex:result directly when normal slash dispatch misses", async () => {
  const repoDir = createGitRepo("pi-codex-input-result-");
  const homeDir = makeTempDir("pi-codex-home-");

  try {
    await withHomeDir(homeDir, async () => {
      const reports = [];
      const handlers = new Map();
      const commands = new Map();

      registerCodexExtension({
        registerCommand(name, options) {
          commands.set(name, options);
        },
        on(name, handler) {
          handlers.set(name, handler);
        },
        registerMessageRenderer() {},
        sendMessage(message, options) {
          reports.push({ message, options });
        },
        sendUserMessage() {
          throw new Error("sendUserMessage should not be called for result fallback");
        },
        getActiveTools() {
          return ["read", "grep", "find", "ls"];
        },
        getAllTools() {
          return [];
        },
        events: {
          emit() {},
        },
      });

      const job = buildResearchJob(repoDir, {
        id: "research-fallback",
        status: "completed",
        phase: "completed",
        startedAt: iso(),
        completedAt: iso(1000),
      });
      createResearchBackgroundJob(job, buildResearchSnapshot(repoDir, { request: "fallback routing" }));
      writeResearchJobResult(
        repoDir,
        job.id,
        {
          request: "fallback routing",
          finalText: "RESULT_FROM_FALLBACK",
          activeToolNames: ["read", "find"],
          missingToolNames: [],
        },
        "# Codex Research\n\nRESULT_FROM_FALLBACK\n",
      );

      const inputHandler = handlers.get("input");
      assert.equal(typeof inputHandler, "function");

      const result = await inputHandler(
        {
          type: "input",
          text: `/codex:result ${job.id}`,
          source: "interactive",
        },
        {
          ui: {
            notify() {},
            setStatus() {},
            theme: {
              fg(_token, value) {
                return value;
              },
              bg(_token, value) {
                return value;
              },
              bold(value) {
                return value;
              },
            },
          },
          hasUI: false,
          cwd: repoDir,
          sessionManager: {
            getSessionId() {
              return "session-a";
            },
            getSessionFile() {
              return "/tmp/session-a.jsonl";
            },
          },
          modelRegistry: {},
          model: {
            provider: "openai-codex",
            id: "gpt-5.3-codex",
          },
          isIdle() {
            return true;
          },
          signal: undefined,
          abort() {},
          hasPendingMessages() {
            return false;
          },
          shutdown() {},
          getContextUsage() {
            return undefined;
          },
          compact() {},
          getSystemPrompt() {
            return "";
          },
        },
      );

      assert.deepEqual(result, { action: "handled" });
      assert.ok(commands.has("codex:result"));
      assert.ok(
        reports.some((entry) => String(entry.message.content).includes("RESULT_FROM_FALLBACK")),
        "fallback input route should emit the stored result as a report",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("input fallback routes /codex:result --last to the newest finished result", async () => {
  const repoDir = createGitRepo("pi-codex-input-result-last-");
  const homeDir = makeTempDir("pi-codex-home-");

  try {
    await withHomeDir(homeDir, async () => {
      const reports = [];
      const handlers = new Map();

      registerCodexExtension({
        registerCommand() {},
        on(name, handler) {
          handlers.set(name, handler);
        },
        registerMessageRenderer() {},
        sendMessage(message, options) {
          reports.push({ message, options });
        },
        sendUserMessage() {
          throw new Error("sendUserMessage should not be called for result fallback");
        },
        getActiveTools() {
          return ["read", "grep", "find", "ls"];
        },
        getAllTools() {
          return [];
        },
        events: {
          emit() {},
        },
      });

      const completedJob = buildResearchJob(repoDir, {
        id: "research-completed",
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:03:00.000Z",
        startedAt: "2026-04-06T10:00:10.000Z",
        completedAt: "2026-04-06T10:03:00.000Z",
        status: "completed",
        phase: "completed",
      });
      createResearchBackgroundJob(completedJob, buildResearchSnapshot(repoDir, { request: "older completed research" }));
      writeResearchJobResult(
        repoDir,
        completedJob.id,
        {
          request: "older completed research",
          finalText: "BACKGROUND_RESULT",
          activeToolNames: ["read", "find"],
          missingToolNames: [],
        },
        "# Codex Research\n\nBACKGROUND_RESULT\n",
      );

      const runningJob = buildResearchJob(repoDir, {
        id: "research-running",
        createdAt: "2026-04-06T10:04:00.000Z",
        updatedAt: "2026-04-06T10:05:00.000Z",
        startedAt: "2026-04-06T10:04:10.000Z",
        status: "running",
        phase: "agent-turn",
        runnerPid: process.pid,
      });
      createResearchBackgroundJob(runningJob, buildResearchSnapshot(repoDir, { request: "newer running research" }));

      storeReviewRun(
        repoDir,
        reviewRun({
          id: "review-latest",
          createdAt: "2026-04-06T09:59:00.000Z",
          startedAt: "2026-04-06T09:59:00.000Z",
          completedAt: "2026-04-06T10:06:00.000Z",
          result: {
            verdict: "approve",
            summary: "LATEST_REVIEW_RESULT",
            findings: [],
            next_steps: [],
          },
        }),
        20,
      );

      const inputHandler = handlers.get("input");
      assert.equal(typeof inputHandler, "function");

      const result = await inputHandler(
        {
          type: "input",
          text: "/codex:result --last",
          source: "interactive",
        },
        {
          ui: {
            notify() {},
            setStatus() {},
            theme: {
              fg(_token, value) {
                return value;
              },
              bg(_token, value) {
                return value;
              },
              bold(value) {
                return value;
              },
            },
          },
          hasUI: false,
          cwd: repoDir,
          sessionManager: {
            getSessionId() {
              return "session-a";
            },
            getSessionFile() {
              return "/tmp/session-a.jsonl";
            },
          },
          modelRegistry: {},
          model: {
            provider: "openai-codex",
            id: "gpt-5.3-codex",
          },
          isIdle() {
            return true;
          },
          signal: undefined,
          abort() {},
          hasPendingMessages() {
            return false;
          },
          shutdown() {},
          getContextUsage() {
            return undefined;
          },
          compact() {},
          getSystemPrompt() {
            return "";
          },
        },
      );

      assert.deepEqual(result, { action: "handled" });
      assert.ok(
        reports.some((entry) => String(entry.message.content).includes("LATEST_REVIEW_RESULT")),
        "explicit --last should resolve to the newest finished result by completion time, even when a newer background job is still running",
      );
      assert.ok(
        reports.every((entry) => !String(entry.message.content).includes("BACKGROUND_RESULT")),
        "explicit --last should ignore older background results when a newer foreground review exists",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("input fallback routes /codex:result --last to a newer failed background job when it is newer than stored reviews", async () => {
  const repoDir = createGitRepo("pi-codex-input-result-last-failed-");
  const homeDir = makeTempDir("pi-codex-home-");

  try {
    await withHomeDir(homeDir, async () => {
      const reports = [];
      const handlers = new Map();

      registerCodexExtension({
        registerCommand() {},
        on(name, handler) {
          handlers.set(name, handler);
        },
        registerMessageRenderer() {},
        sendMessage(message, options) {
          reports.push({ message, options });
        },
        sendUserMessage() {
          throw new Error("sendUserMessage should not be called for result fallback");
        },
        getActiveTools() {
          return ["read", "grep", "find", "ls"];
        },
        getAllTools() {
          return [];
        },
        events: {
          emit() {},
        },
      });

      storeReviewRun(
        repoDir,
        reviewRun({
          id: "review-older",
          createdAt: "2026-04-06T10:06:00.000Z",
          result: {
            verdict: "approve",
            summary: "OLDER_REVIEW_RESULT",
            findings: [],
            next_steps: [],
          },
        }),
        20,
      );

      const failedJob = buildResearchJob(repoDir, {
        id: "research-failed-latest",
        createdAt: "2026-04-06T10:07:00.000Z",
        updatedAt: "2026-04-06T10:08:00.000Z",
        startedAt: "2026-04-06T10:07:10.000Z",
        completedAt: "2026-04-06T10:08:00.000Z",
        status: "failed",
        phase: "failed",
        errorMessage: "LATEST_FAILED_RESULT",
      });
      createResearchBackgroundJob(failedJob, buildResearchSnapshot(repoDir, { request: "newer failed research" }));

      const inputHandler = handlers.get("input");
      assert.equal(typeof inputHandler, "function");

      const result = await inputHandler(
        {
          type: "input",
          text: "/codex:result --last",
          source: "interactive",
        },
        {
          ui: {
            notify() {},
            setStatus() {},
            theme: {
              fg(_token, value) {
                return value;
              },
              bg(_token, value) {
                return value;
              },
              bold(value) {
                return value;
              },
            },
          },
          hasUI: false,
          cwd: repoDir,
          sessionManager: {
            getSessionId() {
              return "session-a";
            },
            getSessionFile() {
              return "/tmp/session-a.jsonl";
            },
          },
          modelRegistry: {},
          model: {
            provider: "openai-codex",
            id: "gpt-5.3-codex",
          },
          isIdle() {
            return true;
          },
          signal: undefined,
          abort() {},
          hasPendingMessages() {
            return false;
          },
          shutdown() {},
          getContextUsage() {
            return undefined;
          },
          compact() {},
          getSystemPrompt() {
            return "";
          },
        },
      );

      assert.deepEqual(result, { action: "handled" });
      assert.ok(
        reports.some((entry) => String(entry.message.content).includes("LATEST_FAILED_RESULT")),
        "explicit --last should surface the newest failed background job when it is newer than stored reviews",
      );
      assert.ok(
        reports.every((entry) => !String(entry.message.content).includes("OLDER_REVIEW_RESULT")),
        "explicit --last should not hide a newer failed background job behind an older stored review",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("print-mode task fallback cleans up stale waiters after an error", async () => {
  const repoDir = createGitRepo("pi-codex-print-waiter-");
  const homeDir = makeTempDir("pi-codex-home-");
  const previousArgv = [...process.argv];
  process.argv = [...process.argv, "-p"];

  try {
    const moduleUrl = new URL("../extensions/core/index.ts", import.meta.url).href;
    const { default: registerPrintModeCodexExtension } = await import(`${moduleUrl}?print-waiter=${Date.now()}`);

    await withHomeDir(homeDir, async () => {
      const reports = [];
      const handlers = new Map();
      let sendUserMessageCount = 0;
      let authMode = "fail";

      registerPrintModeCodexExtension({
        registerCommand() {},
        on(name, handler) {
          handlers.set(name, handler);
        },
        registerMessageRenderer() {},
        sendMessage(message, options) {
          reports.push({ message, options });
        },
        sendUserMessage() {
          sendUserMessageCount += 1;
        },
        getActiveTools() {
          return ["read", "grep", "find", "ls"];
        },
        getAllTools() {
          return [];
        },
        getThinkingLevel() {
          return "medium";
        },
        setThinkingLevel() {},
        events: {
          emit() {},
        },
      });

      const inputHandler = handlers.get("input");
      const turnEndHandler = handlers.get("turn_end");
      assert.equal(typeof inputHandler, "function");
      assert.equal(typeof turnEndHandler, "function");

      const failingPromise = inputHandler(
        {
          type: "input",
          text: "/codex:task --background --readonly fail auth preflight",
          source: "interactive",
        },
        {
          hasUI: false,
          cwd: repoDir,
          isIdle() {
            return true;
          },
          model: {
            provider: "openai-codex",
            id: "gpt-5.3-codex",
          },
          modelRegistry: {
            async getApiKeyAndHeaders() {
              if (authMode === "fail") {
                return { ok: false, error: "No API key found for openai-codex." };
              }
              return { ok: true, apiKey: "unused", headers: {} };
            },
          },
          sessionManager: {
            getSessionId() {
              return "session-a";
            },
            getSessionFile() {
              return "/tmp/session-a.jsonl";
            },
          },
          ui: {
            notify() {},
            setStatus() {},
            theme: {
              fg(_token, value) {
                return value;
              },
            },
          },
        },
      );
      await failingPromise;
      assert.ok(reports.some((entry) => String(entry.message.content).includes("No API key found for openai-codex.")));

      authMode = "ok";
      let resolved = false;
      const reportsAfterFailure = reports.length;
      const secondPromise = inputHandler(
        {
          type: "input",
          text: "/codex:task --readonly inspect auth refresh",
          source: "interactive",
        },
        {
          hasUI: false,
          cwd: repoDir,
          isIdle() {
            return true;
          },
          model: {
            provider: "openai-codex",
            id: "gpt-5.3-codex",
          },
          modelRegistry: {
            async getApiKeyAndHeaders() {
              if (authMode === "fail") {
                return { ok: false, error: "No API key found for openai-codex." };
              }
              return { ok: true, apiKey: "unused", headers: {} };
            },
          },
          sessionManager: {
            getSessionId() {
              return "session-a";
            },
            getSessionFile() {
              return "/tmp/session-a.jsonl";
            },
          },
          ui: {
            notify() {},
            setStatus() {},
            theme: {
              fg(_token, value) {
                return value;
              },
            },
          },
        },
      ).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      assert.equal(sendUserMessageCount, 1);
      assert.equal(resolved, false);

      await turnEndHandler();
      await secondPromise;
      assert.equal(resolved, true);
      assert.equal(reports.length, reportsAfterFailure + 1);
      assert.match(String(reports.at(-1)?.message.content), /sent this task to your current PI session/i);
    });
  } finally {
    process.argv = previousArgv;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
