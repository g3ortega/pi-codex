import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCodexSettings, registerCodexSettings, renderSettingsMarkdown } from "../src/config/codex-settings.ts";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withHomeDir(homeDir, fn) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

test("loadCodexSettings merges extension, global, and nearest project settings in precedence order", () => {
  const root = makeTempDir("pi-codex-config-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  const nestedCwd = path.join(workspaceRoot, "packages", "app");
  fs.mkdirSync(nestedCwd, { recursive: true });

  try {
    writeJson(path.join(homeDir, ".pi", "agent", "settings-extensions.json"), {
      codex: {
        defaultReviewScope: "branch",
        reviewHistoryLimit: "10",
        protectLockfiles: "on",
      },
    });

    writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
      codex: {
        enableResearchCommand: false,
        protectedPaths: ["global.env"],
      },
    });

    writeJson(path.join(workspaceRoot, ".pi", "settings.json"), {
      codex: {
        defaultReviewScope: "working-tree",
        enableTaskCommand: false,
        protectedPaths: ["project.env"],
      },
    });

    const settings = withHomeDir(homeDir, () => loadCodexSettings(nestedCwd));

    assert.equal(settings.defaultReviewScope, "working-tree");
    assert.equal(settings.reviewHistoryLimit, 10);
    assert.equal(settings.protectLockfiles, true);
    assert.equal(settings.enableTaskCommand, false);
    assert.equal(settings.enableResearchCommand, false);
    assert.deepEqual(
      settings.protectedPaths,
      ["project.env", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadCodexSettings also consumes extension-backed boolean settings and register output stays aligned", () => {
  const root = makeTempDir("pi-codex-config-extension-settings-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    writeJson(path.join(homeDir, ".pi", "agent", "settings-extensions.json"), {
      codex: {
        defaultReviewScope: "branch",
        defaultReviewModel: " openai-codex/gpt-5.4 ",
        reviewHistoryLimit: "12",
        protectLockfiles: "yes",
        enableTaskCommand: "off",
        enableResearchCommand: "no",
      },
    });

    const settings = withHomeDir(homeDir, () => loadCodexSettings(workspaceRoot));

    assert.equal(settings.defaultReviewScope, "branch");
    assert.equal(settings.defaultReviewModel, "openai-codex/gpt-5.4");
    assert.equal(settings.reviewHistoryLimit, 12);
    assert.equal(settings.protectLockfiles, true);
    assert.equal(settings.enableTaskCommand, false);
    assert.equal(settings.enableResearchCommand, false);
    assert.deepEqual(
      settings.protectedPaths,
      [".env", ".git/", "node_modules/", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"],
    );

    const emitted = [];
    const fakePi = {
      events: {
        emit(eventName, payload) {
          emitted.push({ eventName, payload });
        },
      },
    };
    withHomeDir(homeDir, () => registerCodexSettings(fakePi));

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventName, "pi-extension-settings:register");
    assert.equal(emitted[0].payload.name, "codex");
    assert.deepEqual(
      emitted[0].payload.settings.map((entry) => entry.id),
      [
        "defaultReviewScope",
        "defaultReviewModel",
        "reviewHistoryLimit",
        "protectLockfiles",
        "enableTaskCommand",
        "enableResearchCommand",
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadCodexSettings ignores malformed values, supports comma-separated protected paths, and renders markdown", () => {
  const root = makeTempDir("pi-codex-config-invalid-");
  const homeDir = path.join(root, "home");
  const workspaceRoot = path.join(root, "workspace");
  const nestedCwd = path.join(workspaceRoot, "services", "api");
  fs.mkdirSync(nestedCwd, { recursive: true });

  try {
    writeJson(path.join(homeDir, ".pi", "agent", "settings-extensions.json"), {
      codex: {
        defaultReviewScope: "invalid",
        reviewHistoryLimit: "0",
        protectLockfiles: "no",
        enableTaskCommand: "off",
        enableResearchCommand: "yes",
      },
    });

    writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
      codex: {
        defaultReviewModel: "  openai-codex/gpt-5.3-codex  ",
        protectedPaths: " .secrets , local.env ,, ",
        reviewHistoryLimit: "not-a-number",
      },
    });

    fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
    writeJson(path.join(workspaceRoot, ".pi", "settings.json"), {
      codex: {
        reviewHistoryLimit: 4.8,
        protectedPaths: [],
      },
    });

    const settings = withHomeDir(homeDir, () => loadCodexSettings(nestedCwd));
    const markdown = renderSettingsMarkdown(settings, null);

    assert.equal(settings.defaultReviewScope, "auto");
    assert.equal(settings.defaultReviewModel, "openai-codex/gpt-5.3-codex");
    assert.equal(settings.reviewHistoryLimit, 4);
    assert.equal(settings.protectLockfiles, false);
    assert.equal(settings.enableTaskCommand, false);
    assert.equal(settings.enableResearchCommand, true);
    assert.deepEqual(settings.protectedPaths, []);

    assert.match(markdown, /Current session model: none/);
    assert.match(markdown, /Default review model: openai-codex\/gpt-5\.3-codex/);
    assert.match(markdown, /Review history limit: 4/);
    assert.match(markdown, /Protect lockfiles: off/);
    assert.match(markdown, /Enable task command: off/);
    assert.match(markdown, /Enable research command: on/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
