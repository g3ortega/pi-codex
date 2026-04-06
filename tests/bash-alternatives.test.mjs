import test from "node:test";
import assert from "node:assert/strict";

import { detectBuiltinAlternativeForBash } from "../src/runtime/bash-alternatives.ts";

test("detects simple file discovery commands that should use PI built-ins", () => {
  assert.deepEqual(detectBuiltinAlternativeForBash("find . -maxdepth 3 -type f | sort"), {
    tool: "find",
    reason: "Use the built-in `find` tool for file discovery instead of bash.",
  });

  assert.deepEqual(detectBuiltinAlternativeForBash("ls -la src"), {
    tool: "ls",
    reason: "Use the built-in `ls` tool for directory listing instead of bash.",
  });

  assert.deepEqual(detectBuiltinAlternativeForBash("rg codex src"), {
    tool: "grep",
    reason: "Use the built-in `grep` tool for content search instead of bash.",
  });

  assert.deepEqual(detectBuiltinAlternativeForBash("cat README.md"), {
    tool: "read",
    reason: "Use the built-in `read` tool for file content inspection instead of bash.",
  });
});

test("does not redirect bash when the command is chained, redirected, or riskier find usage", () => {
  assert.equal(detectBuiltinAlternativeForBash("pwd && find . -maxdepth 3 -type f | sort"), null);
  assert.equal(detectBuiltinAlternativeForBash("find . -type f -exec cat {} \\;"), null);
  assert.equal(detectBuiltinAlternativeForBash("find . -type f > out.txt"), null);
  assert.equal(detectBuiltinAlternativeForBash("git diff --stat origin/main...HEAD"), null);
});

test("does not redirect bash when the equivalent builtin tool is inactive", () => {
  assert.equal(detectBuiltinAlternativeForBash("ls -la src", ["bash", "read"]), null);
  assert.equal(detectBuiltinAlternativeForBash("find . -maxdepth 2 -type f", ["bash", "read"]), null);
  assert.equal(detectBuiltinAlternativeForBash("rg codex src", ["bash", "read"]), null);
  assert.equal(detectBuiltinAlternativeForBash("cat README.md", ["bash"]), null);
});
