import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSessionActivityWatchdog } from "../src/background/session-activity.ts";

function makeTempSessionDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-session-activity-"));
}

test("session activity watchdog tolerates missing dirs and reports idle", async () => {
  const missing = path.join(os.tmpdir(), `pi-codex-session-activity-missing-${Date.now()}`);

  const result = await new Promise((resolve) => {
    const watchdog = createSessionActivityWatchdog({
      sessionDir: missing,
      idleTimeoutMs: 40,
      hardTimeoutMs: 400,
      unrefTimer: false,
      onTimeout: (kind) => {
        watchdog.clear();
        resolve(kind);
      },
    });
  });

  assert.equal(result, "idle");
});

test("session activity watchdog times out on idle when no new session activity appears", async () => {
  const dir = makeTempSessionDir();
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "{}\n");
  const start = new Date();
  fs.utimesSync(file, start, start);

  const result = await new Promise((resolve) => {
    const watchdog = createSessionActivityWatchdog({
      sessionDir: dir,
      idleTimeoutMs: 40,
      hardTimeoutMs: 400,
      unrefTimer: false,
      onTimeout: (kind) => {
        watchdog.clear();
        resolve(kind);
      },
    });
  });

  assert.equal(result, "idle");
});

test("session activity watchdog extends active jobs and still enforces a hard cap", async () => {
  const dir = makeTempSessionDir();
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "{}\n");
  const start = new Date();
  fs.utimesSync(file, start, start);

  let touches = 0;
  const touchInterval = setInterval(() => {
    const now = new Date();
    fs.utimesSync(file, now, now);
    touches += 1;
  }, 25);

  const result = await new Promise((resolve) => {
    const watchdog = createSessionActivityWatchdog({
      sessionDir: dir,
      idleTimeoutMs: 60,
      hardTimeoutMs: 180,
      unrefTimer: false,
      onTimeout: (kind) => {
        clearInterval(touchInterval);
        watchdog.clear();
        resolve(kind);
      },
    });
  });

  assert.equal(result, "hard");
  assert.ok(touches >= 3);
});
