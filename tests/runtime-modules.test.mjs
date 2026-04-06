import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { splitLeadingOptionTokens, splitShellLikeArgs } from "../src/runtime/arg-parser.ts";
import { findProtectedPathInBashCommand, findProtectedPathMatch } from "../src/runtime/path-protection.ts";
import { findStoredReview, listStoredReviews, storeReviewRun } from "../src/runtime/review-store.ts";
import { parseTaskCommandOptions } from "../src/runtime/task-command-options.ts";
import {
  getCodexHome,
  getWorkspaceJobsDir,
  getWorkspaceJobsDirForRoot,
  getWorkspaceReviewsDir,
  getWorkspaceRoot,
  getWorkspaceStateDir,
  getWorkspaceStateDirForRoot,
} from "../src/runtime/state-paths.ts";
import { buildInspectionRetryGuidance, buildResearchPrompt, buildTaskPrompt } from "../src/runtime/session-prompts.ts";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupWorkspace(cwd) {
  const stateDir = getWorkspaceStateDir(cwd);
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
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
    parseTaskCommandOptions('--readonly --model openai-codex/gpt-5.3-codex inspect "--background semantics"'),
    {
      background: false,
      profile: "readonly",
      modelSpec: "openai-codex/gpt-5.3-codex",
      request: "inspect --background semantics",
    },
  );

  assert.deepEqual(
    parseTaskCommandOptions("--background --write fix auth refresh"),
    {
      background: true,
      profile: "write",
      modelSpec: undefined,
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
    activeWebTools: [],
    inactiveAvailableWebTools: [],
    activeLocalEvidenceTools: ["bash", "read"],
    activeMutationTools: [],
  });

  assert.match(prompt, /Prefer the active PI read-only inspection tools \(`read`\) for repository inspection\./);
  assert.doesNotMatch(prompt, /Prefer PI read-only tools \(`find`, `ls`, `grep`, `read`\) over `bash`/);
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

test("protected path matching handles both file and directory-style entries", () => {
  assert.equal(findProtectedPathMatch(".env", [".env", ".git/"]), ".env");
  assert.equal(findProtectedPathMatch("config/.env", [".env", ".git/"]), ".env");
  assert.equal(findProtectedPathMatch(".git/config", [".git/"]), ".git/");
  assert.equal(findProtectedPathMatch("repo/.git/hooks/pre-commit", [".git/"]), ".git/");
  assert.equal(findProtectedPathMatch("src/index.ts", [".env", ".git/"]), null);
});

test("protected bash path detection allows read-only inspection but blocks mutations", () => {
  const protectedPaths = [".env", ".git/"];

  assert.equal(findProtectedPathInBashCommand("cat .env", protectedPaths), null);
  assert.equal(findProtectedPathInBashCommand("echo .env", protectedPaths), null);
  assert.equal(findProtectedPathInBashCommand("git status --short", protectedPaths), null);

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
