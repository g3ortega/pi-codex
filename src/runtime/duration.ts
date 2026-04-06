interface DurationTimestamps {
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  updatedAt?: string;
  status?: string;
}

export interface BackgroundDurationSummary {
  queueDelay: string | null;
  runDuration: string | null;
  totalDuration: string | null;
  runningFor: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "lost"]);

export function parseTimestampMs(value?: string): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDurationMs(milliseconds: number): string {
  const safeMs = Math.round(milliseconds);
  if (!Number.isFinite(safeMs) || safeMs < 0) {
    return "";
  }
  if (safeMs < 1_000) {
    return `${Math.max(1, safeMs)}ms`;
  }

  const seconds = safeMs / 1_000;
  if (seconds < 10) {
    return `${seconds.toFixed(1).replace(/\.0$/u, "")}s`;
  }

  const roundedSeconds = Math.round(seconds);
  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  if (roundedSeconds < 3_600) {
    const minutes = Math.floor(roundedSeconds / 60);
    const remainderSeconds = roundedSeconds % 60;
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }

  if (roundedSeconds < 86_400) {
    const hours = Math.floor(roundedSeconds / 3_600);
    const remainderMinutes = Math.floor((roundedSeconds % 3_600) / 60);
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(roundedSeconds / 86_400);
  const remainderHours = Math.floor((roundedSeconds % 86_400) / 3_600);
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

function diffLabel(startMs: number | null, endMs: number | null): string | null {
  if (startMs === null || endMs === null || endMs < startMs) {
    return null;
  }
  return formatDurationMs(endMs - startMs);
}

function resolveTerminalTimestampMs(record: DurationTimestamps): number | null {
  const completedMs = parseTimestampMs(record.completedAt);
  if (completedMs !== null) {
    return completedMs;
  }

  const cancelledMs = parseTimestampMs(record.cancelledAt);
  if (cancelledMs !== null) {
    return cancelledMs;
  }

  if (record.status && TERMINAL_STATUSES.has(record.status)) {
    return parseTimestampMs(record.updatedAt);
  }

  return null;
}

export function summarizeBackgroundDurations(
  record: DurationTimestamps,
  nowMs = Date.now(),
): BackgroundDurationSummary {
  const createdMs = parseTimestampMs(record.createdAt);
  const startedMs = parseTimestampMs(record.startedAt);
  const terminalMs = resolveTerminalTimestampMs(record);
  const activeEndMs = terminalMs ?? (record.status && !TERMINAL_STATUSES.has(record.status) ? nowMs : null);

  return {
    queueDelay: diffLabel(createdMs, startedMs),
    runDuration: diffLabel(startedMs, activeEndMs),
    totalDuration: diffLabel(createdMs, activeEndMs),
    runningFor: terminalMs === null ? diffLabel(startedMs, nowMs) : null,
  };
}

export function summarizeReviewDuration(record: Pick<DurationTimestamps, "createdAt" | "startedAt" | "completedAt">): string | null {
  const startedMs = parseTimestampMs(record.startedAt) ?? parseTimestampMs(record.createdAt);
  const completedMs = parseTimestampMs(record.completedAt);
  return diffLabel(startedMs, completedMs);
}

export function backgroundCompletionDurationLabel(record: DurationTimestamps): string | null {
  const totalDuration = summarizeBackgroundDurations(record).totalDuration;
  if (!totalDuration) {
    return null;
  }

  switch (record.status) {
    case "completed":
      return `Completed in ${totalDuration}`;
    case "cancelled":
      return `Cancelled after ${totalDuration}`;
    case "failed":
    case "lost":
      return `Failed after ${totalDuration}`;
    default:
      return null;
  }
}
