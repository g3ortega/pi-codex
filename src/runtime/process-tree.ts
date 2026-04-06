export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = String((error as NodeJS.ErrnoException).code ?? "");
      if (code === "EPERM") {
        return true;
      }
    }
    return false;
  }
}

export function terminateProcess(pid: number | null | undefined): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }

  const killPid = pid as number;
  const sendSignal = (signal: NodeJS.Signals): boolean => {
    if (process.platform !== "win32") {
      try {
        process.kill(-killPid, signal);
        return true;
      } catch {
        // Fall back to the direct pid below.
      }
    }

    try {
      process.kill(killPid, signal);
      return true;
    } catch {
      return false;
    }
  };

  const signalled = sendSignal("SIGTERM");
  if (!signalled) {
    return false;
  }

  try {
    const escalation = setTimeout(() => {
      try {
        if (isProcessAlive(killPid)) {
          sendSignal("SIGKILL");
        }
      } catch {
        // Best effort escalation only.
      }
    }, 1000);
    escalation.unref();
  } catch {
    // Best effort escalation scheduling only.
  }
  return true;
}
