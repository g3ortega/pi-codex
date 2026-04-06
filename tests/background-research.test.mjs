import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBackgroundResearchToolPlan,
  inspectResearchToolsFromNames,
  summarizeResearchRequest,
} from "../src/runtime/session-prompts.ts";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("background research tool plan keeps safe builtins and active web extensions only", () => {
  const tools = [
    { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
    { name: "grep", sourceInfo: { source: "builtin", path: "<builtin:grep>" } },
    { name: "find", sourceInfo: { source: "builtin", path: "<builtin:find>" } },
    { name: "ls", sourceInfo: { source: "builtin", path: "<builtin:ls>" } },
    { name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } },
    { name: "edit", sourceInfo: { source: "builtin", path: "<builtin:edit>" } },
    { name: "web_search", sourceInfo: { source: "extension", path: "/tmp/web-access/index.ts" } },
    { name: "fetch_content", sourceInfo: { source: "extension", path: "/tmp/web-access/index.ts" } },
    { name: "code_search", sourceInfo: { source: "extension", path: "/tmp/code-search/index.ts" } },
  ];

  const pi = {
    getActiveTools() {
      return ["read", "bash", "web_search", "fetch_content", "edit"];
    },
    getAllTools() {
      return tools;
    },
  };

  const plan = buildBackgroundResearchToolPlan(pi);

  assert.deepEqual(plan.safeBuiltinTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(plan.requestedToolNames, ["fetch_content", "find", "grep", "ls", "read", "web_search"]);
  assert.deepEqual(plan.extensionPaths, ["/tmp/web-access/index.ts"]);
  assert.deepEqual(plan.interactiveSnapshot.activeWebTools, ["fetch_content", "web_search"]);
  assert.deepEqual(plan.interactiveSnapshot.activeMutationTools, ["edit"]);
});

test("research tool inspection from explicit names reflects only the activated child surface", () => {
  const pi = {
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
        { name: "grep", sourceInfo: { source: "builtin", path: "<builtin:grep>" } },
        { name: "web_search", sourceInfo: { source: "extension", path: "/tmp/web-access/index.ts" } },
        { name: "fetch_content", sourceInfo: { source: "extension", path: "/tmp/web-access/index.ts" } },
        { name: "code_search", sourceInfo: { source: "extension", path: "/tmp/code-search/index.ts" } },
        { name: "edit", sourceInfo: { source: "builtin", path: "<builtin:edit>" } },
      ];
    },
  };

  const snapshot = inspectResearchToolsFromNames(pi, ["read", "grep", "web_search"]);
  assert.deepEqual(snapshot.activeWebTools, ["web_search"]);
  assert.deepEqual(snapshot.inactiveAvailableWebTools, ["code_search", "fetch_content"]);
  assert.deepEqual(snapshot.activeLocalEvidenceTools, ["grep", "read"]);
  assert.deepEqual(snapshot.activeMutationTools, []);
});

test("research request summaries stay compact for job status output", () => {
  assert.equal(summarizeResearchRequest("short request"), "short request");
  assert.match(
    summarizeResearchRequest("This is a longer research request that should be trimmed for a status table and background job subject line", 40),
    /^This is a longer research request that\.\.\.$/,
  );
});

test("background research runner uses a session-activity watchdog and tolerates missing pre-start events", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/background/research-job.ts"), "utf8");
  assert.match(source, /MAX_RESEARCH_JOB_DURATION_MS/);
  assert.match(source, /MAX_RESEARCH_JOB_IDLE_MS/);
  assert.match(source, /createSessionActivityWatchdog/);
  assert.match(source, /without new session activity/);
  assert.match(source, /Background research cancelled by/);
  assert.match(source, /without reaching a terminal assistant response/);
  assert.match(source, /before_agent_start/);
  assert.match(source, /awaitingAgentEnd = true/);
  assert.match(source, /Accepted agent_end fallback without matching before_agent_start/);
  assert.match(source, /awaitingAgentEnd = false/);
  assert.match(source, /Observed cancellation request from job state/);
});

test("detached background workers close inherited log descriptors in the launcher process", () => {
  const researchSource = fs.readFileSync(path.join(ROOT, "src/background/research-job.ts"), "utf8");
  const reviewSource = fs.readFileSync(path.join(ROOT, "src/background/review-job.ts"), "utf8");
  assert.match(researchSource, /closeSync\(stdout\)/);
  assert.match(researchSource, /closeSync\(stderr\)/);
  assert.match(reviewSource, /closeSync\(stdout\)/);
  assert.match(reviewSource, /closeSync\(stderr\)/);
  assert.match(reviewSource, /"--model"/);
});

test("background job updates are serialized and preserve terminal states", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/runtime/job-store.ts"), "utf8");
  assert.match(source, /withJobLock/);
  assert.match(source, /Timed out acquiring job lock/);
  assert.match(source, /isTerminalJobStatus\(current\.status\) \? current : next/);
  assert.match(source, /status: "cancelling"/);
  assert.match(source, /awaiting worker acknowledgement/);
  assert.match(source, /appendJobLog\(workspaceRoot: string, jobId: string, message: string\): void \{\s+const trimmed = message\.trim\(\);[\s\S]+withJobLock\(workspaceRoot, jobId,/);
});

test("background cancellation uses process groups and workers honor cancelling before writing results", () => {
  const processSource = fs.readFileSync(path.join(ROOT, "src/runtime/process-tree.ts"), "utf8");
  const reviewSource = fs.readFileSync(path.join(ROOT, "src/background/review-job.ts"), "utf8");
  const researchSource = fs.readFileSync(path.join(ROOT, "src/background/research-job.ts"), "utf8");
  const renderSource = fs.readFileSync(path.join(ROOT, "src/runtime/job-render.ts"), "utf8");
  assert.match(processSource, /process\.kill\(-killPid, signal\)/);
  assert.match(reviewSource, /current\?\.status === "cancelled" \|\| current\?\.status === "cancelling"/);
  assert.match(reviewSource, /cancelled before persisting a result/);
  assert.match(researchSource, /latestJob\?\.status === "cancelled" \|\| latestJob\?\.status === "cancelling"/);
  assert.match(researchSource, /cancelled before persisting a result/);
  assert.match(renderSource, /Cancellation was requested\. Waiting for the background/);
});

test("status, result, and cancel handlers degrade ambiguous job and stored-review prefixes to warning reports", () => {
  const source = fs.readFileSync(path.join(ROOT, "extensions/core/index.ts"), "utf8");
  assert.match(source, /handleStatusCommand/);
  assert.match(source, /handleResultCommand/);
  assert.match(source, /handleCancelCommand/);
  assert.match(source, /Job reference "\\$\\{reference\\}" is ambiguous|const message = error instanceof Error \? error\.message : String\(error\)/);
  assert.match(source, /Review reference "\\$\\{reference\\}" is ambiguous|findStoredReview\(ctx\.cwd, reference\)/);
  assert.match(source, /sendReport\(pi, "Codex Status"/);
  assert.match(source, /sendReport\(pi, "Codex Result"/);
  assert.match(source, /sendReport\(pi, "Codex Cancel"/);
});

test("slash command option parsing only consumes leading flags and respects end-of-options", () => {
  const coreSource = fs.readFileSync(path.join(ROOT, "extensions/core/index.ts"), "utf8");
  const parserSource = fs.readFileSync(path.join(ROOT, "src/runtime/arg-parser.ts"), "utf8");
  assert.match(coreSource, /import \{ splitLeadingOptionTokens, splitShellLikeArgs \} from "\.\.\/\.\.\/src\/runtime\/arg-parser\.js"/);
  assert.match(coreSource, /splitLeadingOptionTokens\(tokens, \["--scope", "--base", "--model"\]\)/);
  assert.match(coreSource, /splitLeadingOptionTokens\(tokens, \["--model"\]\)/);
  assert.match(parserSource, /export function splitLeadingOptionTokens\(/);
  assert.match(parserSource, /if \(token === "--"\)/);
  assert.match(parserSource, /remainderTokens: tokens\.slice\(index \+ 1\)/);
  assert.match(parserSource, /if \(!token\.startsWith\("--"\)\)/);
  assert.match(parserSource, /const optionsWithValueSet = new Set\(optionsWithValues\)/);
  assert.match(parserSource, /if \(optionsWithValueSet\.has\(token\) && next && next !== "--" && !next\.startsWith\("--"\)\)/);
});
