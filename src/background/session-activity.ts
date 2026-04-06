import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type TimeoutKind = "idle" | "hard";

type SessionActivityWatchdogOptions = {
  sessionDir: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  onTimeout: (kind: TimeoutKind) => void;
  unrefTimer?: boolean;
};

function safeLatestSessionActivityMs(sessionDir: string, floorMs: number): number {
  let latest = floorMs;

  try {
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const candidate = statSync(join(sessionDir, entry.name)).mtimeMs;
      if (Number.isFinite(candidate) && candidate > latest) {
        latest = candidate;
      }
    }
  } catch {
    // Best effort only. The session dir may not exist yet when the watchdog starts.
  }

  return latest;
}

export function latestSessionActivityMs(sessionDir: string, floorMs = 0): number {
  return safeLatestSessionActivityMs(sessionDir, floorMs);
}

export function createSessionActivityWatchdog(options: SessionActivityWatchdogOptions): { clear: () => void } {
  const startedAtMs = Date.now();
  let latestProgressMs = safeLatestSessionActivityMs(options.sessionDir, startedAtMs);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const clear = () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    if (closed) {
      return;
    }

    latestProgressMs = safeLatestSessionActivityMs(options.sessionDir, latestProgressMs);
    const now = Date.now();
    const hardDeadlineMs = startedAtMs + options.hardTimeoutMs;
    const idleDeadlineMs = latestProgressMs + options.idleTimeoutMs;
    const nextCheckMs = Math.max(1, Math.min(hardDeadlineMs - now, idleDeadlineMs - now));

    timer = setTimeout(() => {
      if (closed) {
        return;
      }

      latestProgressMs = safeLatestSessionActivityMs(options.sessionDir, latestProgressMs);
      const checkNow = Date.now();

      if (checkNow - startedAtMs >= options.hardTimeoutMs) {
        clear();
        options.onTimeout("hard");
        return;
      }

      if (checkNow - latestProgressMs >= options.idleTimeoutMs) {
        clear();
        options.onTimeout("idle");
        return;
      }

      arm();
    }, nextCheckMs);
    if (options.unrefTimer ?? true) {
      timer.unref();
    }
  };

  arm();
  return { clear };
}
