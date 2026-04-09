import { backgroundJobSubject, isResearchBackgroundJob, isTaskBackgroundJob } from "./job-types.js";
import type { CodexBackgroundJob } from "./job-types.js";
import { backgroundCompletionDurationLabel, summarizeBackgroundDurations } from "./duration.js";
import { reviewKindTitle } from "../review/review-kind.js";

const INLINE_COMPLETION_MAX_CHARS = 2_400;
const INLINE_COMPLETION_MAX_LINES = 48;

function formatWhen(value: string | undefined): string {
  return value ?? "n/a";
}

function reviewResultFollowUp(job: Extract<CodexBackgroundJob, { jobClass: "review" }>): string {
  return "Use `/codex:status` for progress, `/codex:result --last` for the latest review, `/codex:result <job-id>` for this exact result, or `/codex:cancel <job-id>` to stop it.";
}

export function renderBackgroundJobLaunchMarkdown(job: CodexBackgroundJob): string {
  const title = backgroundJobTitle(job, true);
  const subjectLabel = job.jobClass === "review" ? "Target" : "Request";
  const lines = [
    `# ${title}`,
    "",
    job.jobClass === "review"
      ? job.kind === "adversarial-mental-models-review"
        ? "Started a background adversarial mental-models review."
        : "Started a background review."
      : job.jobClass === "research"
        ? "Started background research."
        : job.profile === "write"
          ? "Started a background write task in an isolated worktree."
          : "Started a background read-only task.",
    "",
    `- Job ID: ${job.id}`,
    `- Status: ${job.status}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- ${subjectLabel}: ${backgroundJobSubject(job)}`,
    `- Model: ${job.modelSpec}`,
    `- Thinking: ${job.thinkingLevel ?? "off"}`,
    `- Created: ${job.createdAt}`,
    "",
    job.jobClass === "review"
      ? reviewResultFollowUp(job)
      : job.jobClass === "research"
        ? "Use `/codex:status` for progress, `/codex:result --last` for the latest research result, `/codex:result <job-id>` for this exact result, or `/codex:cancel <job-id>` to stop it."
        : job.profile === "write"
          ? "Use `/codex:status` for progress, `/codex:result --last` for the latest task result, `/codex:result <job-id>` for this exact result, `/codex:apply <job-id>` to apply the stored patch, or `/codex:cancel <job-id>` to stop it."
          : "Use `/codex:status` for progress, `/codex:result --last` for the latest task result, `/codex:result <job-id>` for this exact result, or `/codex:cancel <job-id>` to stop it.",
  ];

  if (job.jobClass === "review" && job.focusText) {
    lines.splice(9, 0, `- Focus: ${job.focusText}`);
  }
  if (isTaskBackgroundJob(job)) {
    lines.push(`- Mode: ${job.profile}`);
  }
  if ((job.jobClass === "review" && job.safeBuiltinTools) || isResearchBackgroundJob(job) || isTaskBackgroundJob(job)) {
    lines.push(
      "",
      "Available tools:",
      `- Worker built-in tools: ${(job.safeBuiltinTools ?? []).length > 0 ? (job.safeBuiltinTools ?? []).join(", ") : "none"}`,
      ...(isResearchBackgroundJob(job) ? [`- Native Codex web search: ${job.nativeWebSearchEnabled ? "enabled" : "disabled"}`] : []),
      `- Active web tools: ${(job.activeWebTools ?? []).length > 0 ? (job.activeWebTools ?? []).join(", ") : "none"}`,
    );
  }
  if (isTaskBackgroundJob(job) && job.profile === "write") {
    lines.push(
      "",
      "Isolation:",
      `- Execution cwd: ${job.executionCwd}`,
      `- Worktree path: ${job.worktreePath ?? "n/a"}`,
      `- Worktree branch: ${job.worktreeBranch ?? "n/a"}`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderBackgroundJobMarkdown(job: CodexBackgroundJob): string {
  const title = backgroundJobTitle(job, true);
  const subjectLabel = job.jobClass === "review" ? "Target" : "Request";
  const timings = summarizeBackgroundDurations(job);
  const isTerminal = job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "lost";
  const lines = [
    `# ${title}`,
    "",
    `- Job ID: ${job.id}`,
    `- Status: ${job.status}`,
    `- Phase: ${job.phase}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- ${subjectLabel}: ${backgroundJobSubject(job)}`,
    `- Model: ${job.modelSpec}`,
    `- Thinking: ${job.thinkingLevel ?? "off"}`,
    `- Created: ${job.createdAt}`,
    `- Updated: ${job.updatedAt}`,
  ];

  if (job.startedAt) {
    lines.push(`- Started: ${job.startedAt}`);
  }
  if (job.completedAt) {
    lines.push(`- Completed: ${job.completedAt}`);
  }
  if (job.cancelledAt) {
    lines.push(`- Cancelled: ${job.cancelledAt}`);
  }
  if (job.lastHeartbeatAt) {
    lines.push(`- Last heartbeat: ${job.lastHeartbeatAt}`);
  }
  if (timings.queueDelay) {
    lines.push(`- Queue delay: ${timings.queueDelay}`);
  }
  if (timings.runDuration && isTerminal) {
    lines.push(`- Run duration: ${timings.runDuration}`);
  }
  if (timings.totalDuration && isTerminal) {
    lines.push(`- Total duration: ${timings.totalDuration}`);
  } else if (timings.runningFor && (job.status === "running" || job.status === "cancelling")) {
    lines.push(`- Running for: ${timings.runningFor}`);
  }
  if (job.jobClass === "review" && job.focusText) {
    lines.push(`- Focus: ${job.focusText}`);
  }
  if (job.jobClass === "review" && job.resultVerdict) {
    lines.push(`- Verdict: ${job.resultVerdict}`);
  }
  if (isTaskBackgroundJob(job)) {
    lines.push(`- Mode: ${job.profile}`);
  }
  if ((job.jobClass === "review" && job.safeBuiltinTools) || isResearchBackgroundJob(job) || isTaskBackgroundJob(job)) {
    lines.push(`- Worker built-in tools: ${(job.safeBuiltinTools ?? []).length > 0 ? (job.safeBuiltinTools ?? []).join(", ") : "none"}`);
    if (isResearchBackgroundJob(job)) {
      lines.push(`- Native Codex web search: ${job.nativeWebSearchEnabled ? "enabled" : "disabled"}`);
    }
    lines.push(`- Active web tools: ${(job.activeWebTools ?? []).length > 0 ? (job.activeWebTools ?? []).join(", ") : "none"}`);
    lines.push(`- Activated tools: ${(job.activeToolNames ?? []).length > 0 ? (job.activeToolNames ?? []).join(", ") : "pending"}`);
    if (job.missingToolNames && job.missingToolNames.length > 0) {
      lines.push(`- Missing requested tools: ${job.missingToolNames.join(", ")}`);
    }
  }
  if (isTaskBackgroundJob(job) && job.profile === "write") {
    lines.push(`- Execution cwd: ${job.executionCwd}`);
    lines.push(`- Worktree path: ${job.worktreePath ?? "n/a"}`);
    lines.push(`- Worktree branch: ${job.worktreeBranch ?? "n/a"}`);
    if (job.patchFile) {
      lines.push(`- Patch file: ${job.patchFile}`);
      lines.push(`- Files changed: ${String(job.filesChanged ?? 0)}`);
      lines.push(`- Insertions: ${String(job.insertions ?? 0)}`);
      lines.push(`- Deletions: ${String(job.deletions ?? 0)}`);
      if (job.diffStat?.trim()) {
        lines.push("", "Diff stat:", "", job.diffStat);
      }
    }
  }
  if (job.errorMessage) {
    lines.push("", "Error:", `- ${job.errorMessage}`);
  }

  lines.push("");

  switch (job.status) {
    case "queued":
    case "starting":
    case "running":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "This background adversarial mental-models review is still running."
            : "This background review is still running."
          : job.jobClass === "research"
            ? "This background research job is still running."
            : job.profile === "write"
              ? "This background write task is still running in its isolated worktree."
              : "This background read-only task is still running.",
      );
      break;
    case "cancelling":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "Cancellation requested. Waiting for the background adversarial mental-models review to stop."
            : "Cancellation requested. Waiting for the background review to stop."
          : job.jobClass === "research"
            ? "Cancellation requested. Waiting for the background research run to stop."
            : job.profile === "write"
              ? "Cancellation requested. Waiting for the isolated background write worker to stop."
              : "Cancellation requested. Waiting for the background task to stop.",
      );
      break;
    case "cancelled":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "The background adversarial mental-models review was cancelled before it finished."
            : "The background review was cancelled before it finished."
          : job.jobClass === "research"
            ? "The background research job was cancelled before it finished."
            : job.profile === "write"
              ? "The background write task was cancelled before it finished."
              : "The background read-only task was cancelled before it finished.",
      );
      break;
    case "lost":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "The background adversarial mental-models review disappeared before it reported a final result."
            : "The background review disappeared before it reported a final result."
          : job.jobClass === "research"
            ? "The background research run disappeared before it reported a final result."
            : job.profile === "write"
              ? "The background write worker disappeared before it reported a final result."
              : "The background task disappeared before it reported a final result.",
      );
      break;
    case "failed":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "The background adversarial mental-models review failed before it produced a result."
            : "The background review failed before it produced a result."
          : job.jobClass === "research"
            ? "The background research job failed before it produced a result."
            : job.profile === "write"
              ? "The background write task failed before it produced a result."
              : "The background read-only task failed before it produced a result.",
      );
      break;
    case "completed":
      lines.push(
        job.jobClass === "review"
          ? job.kind === "adversarial-mental-models-review"
            ? "The background adversarial mental-models review finished. Use `/codex:result --last` for the latest review or `/codex:result " + job.id + "` for this exact result."
            : "The background review finished. Use `/codex:result --last` for the latest review or `/codex:result " + job.id + "` for this exact result."
          : job.jobClass === "research"
            ? "The background research finished. Use `/codex:result --last` for the latest research result or `/codex:result " + job.id + "` for this exact result."
            : job.profile === "write"
              ? "The background write task finished in an isolated worktree. Use `/codex:result --last` for the latest task result, `/codex:result " + job.id + "` for this exact result, or `/codex:apply " + job.id + "` to apply the patch."
              : "The background read-only task finished. Use `/codex:result --last` for the latest task result or `/codex:result " + job.id + "` for this exact result.",
      );
      break;
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function summarizeText(text: string, limit = 320): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const firstParagraph = trimmed.split(/\n\s*\n/u).find((entry) => entry.trim())?.trim() ?? trimmed;
  const singleLine = firstParagraph.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= limit) {
    return singleLine;
  }
  return `${singleLine.slice(0, limit - 3)}...`;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function summarizeMarkdownExcerpt(markdown: string, maxChars = 700, maxLines = 8): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return "";
  }

  const excerpt: string[] = [];
  let usedChars = 0;

  for (const line of lines) {
    const compact = line.trim();
    const normalized = compact.length > 220 ? `${compact.slice(0, 217).trimEnd()}...` : compact;
    const projectedChars = usedChars + normalized.length + (excerpt.length > 0 ? 1 : 0);
    if (excerpt.length > 0 && projectedChars > maxChars) {
      break;
    }
    excerpt.push(normalized);
    usedChars = projectedChars;
    if (excerpt.length >= maxLines) {
      break;
    }
  }

  const preview = excerpt.join("\n");
  if (!preview) {
    return "";
  }

  return excerpt.length < lines.length ? `${preview}\n...` : preview;
}

function shouldInlineFullCompletion(job: CodexBackgroundJob, fullResultMarkdown: string): boolean {
  if (job.status !== "completed") {
    return false;
  }

  const trimmed = fullResultMarkdown.trim();
  if (!trimmed) {
    return false;
  }

  return trimmed.length <= INLINE_COMPLETION_MAX_CHARS && countLines(trimmed) <= INLINE_COMPLETION_MAX_LINES;
}

function extractFinalAnswerPreview(fullResultMarkdown: string | undefined, fallbackSummary: string | undefined): string {
  const markdown = fullResultMarkdown?.trim() ?? "";
  if (markdown) {
    const finalAnswerIndex = markdown.lastIndexOf("\nFinal answer:");
    if (finalAnswerIndex >= 0) {
      const answer = markdown.slice(finalAnswerIndex + "\nFinal answer:".length).trim();
      if (answer) {
        const preview = summarizeMarkdownExcerpt(answer, 700, 8);
        if (preview) {
          return preview;
        }
      }
    }
  }

  return summarizeText(fallbackSummary ?? "", 700);
}

function completionNextStepLine(job: CodexBackgroundJob): string {
  return job.jobClass === "review"
    ? `Use \`/codex:result --last\` for the latest review or \`/codex:result ${job.id}\` for this exact result.`
    : job.jobClass === "research"
      ? `Use \`/codex:result --last\` for the latest research result or \`/codex:result ${job.id}\` for this exact result.`
      : job.profile === "write"
        ? `Use \`/codex:result --last\` for the latest task result, \`/codex:result ${job.id}\` for this exact result, or \`/codex:apply ${job.id}\` to apply the patch.`
        : `Use \`/codex:result --last\` for the latest task result or \`/codex:result ${job.id}\` for this exact result.`;
}

export function backgroundJobTitle(job: CodexBackgroundJob, includeJobSuffix = false): string {
  const base = job.jobClass === "review"
    ? reviewKindTitle(job.kind)
    : job.jobClass === "research"
      ? "Codex Research"
      : "Codex Task";
  return includeJobSuffix ? `${base} Job` : base;
}

export function backgroundJobNotificationTitle(job: CodexBackgroundJob): string {
  const base = backgroundJobTitle(job, false);

  switch (job.status) {
    case "completed":
      return `${base} Complete`;
    case "failed":
      return `${base} Failed`;
    case "cancelled":
      return `${base} Cancelled`;
    case "lost":
      return `${base} Lost`;
    default:
      return `${base} Update`;
  }
}

export function backgroundJobReportVariant(job: CodexBackgroundJob): "info" | "success" | "warning" | "error" {
  if (job.status === "failed" || job.status === "lost") {
    return "error";
  }
  if (job.status === "cancelled") {
    return "warning";
  }
  if (job.jobClass === "review" && job.resultVerdict === "needs-attention") {
    return "warning";
  }
  if (job.status === "completed") {
    return "success";
  }
  return "info";
}

export function renderBackgroundJobCompletionMarkdown(
  job: CodexBackgroundJob,
  summaryText?: string,
  fullResultMarkdown?: string,
): string {
  if (fullResultMarkdown && shouldInlineFullCompletion(job, fullResultMarkdown)) {
    return fullResultMarkdown.endsWith("\n") ? fullResultMarkdown : `${fullResultMarkdown}\n`;
  }

  const subjectLabel = job.jobClass === "review" ? "Target" : "Request";
  const lines = [
    `# ${backgroundJobNotificationTitle(job)}`,
    "",
    `- Job ID: ${job.id}`,
    `- Kind: ${job.kind}`,
    `- Status: ${job.status}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- ${subjectLabel}: ${backgroundJobSubject(job)}`,
    `- Model: ${job.modelSpec}`,
  ];
  const durationLabel = backgroundCompletionDurationLabel(job);
  if (durationLabel) {
    lines.push(`- Timing: ${durationLabel}`);
  }

  if (job.jobClass === "review" && job.resultVerdict) {
    lines.push(`- Verdict: ${job.resultVerdict}`);
  }
  if (isTaskBackgroundJob(job)) {
    lines.push(`- Mode: ${job.profile}`);
  }

  if (summaryText?.trim()) {
    if (job.jobClass === "review") {
      lines.push("", "Summary:", "", summarizeText(summaryText));
    } else {
      lines.push("", "Preview:", "", extractFinalAnswerPreview(fullResultMarkdown, summaryText));
      if (fullResultMarkdown && !shouldInlineFullCompletion(job, fullResultMarkdown)) {
        lines.push("", "Result was too long to inline fully in the completion notification.");
      }
    }
  } else if (job.errorMessage?.trim()) {
    lines.push("", "Error:", "", summarizeText(job.errorMessage));
  }

  lines.push("", completionNextStepLine(job));

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderBackgroundJobsOverviewMarkdown(jobs: CodexBackgroundJob[], title = "Codex Status"): string {
  if (jobs.length === 0) {
    return `# ${title}\n\nNo background Codex jobs for this workspace yet.\n`;
  }

  const lines = [
    `# ${title}`,
    "",
    "| Job ID | Kind | Status | Phase | Verdict | Branch | Subject | Updated |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const job of jobs) {
    lines.push(
      `| ${job.id} | ${job.kind} | ${job.status} | ${job.phase} | ${job.jobClass === "review" ? job.resultVerdict ?? "-" : "-"} | ${job.branch} | ${backgroundJobSubject(job).replace(/\|/g, "\\|")} | ${formatWhen(job.updatedAt)} |`,
    );
  }

  lines.push(
    "",
    "Use `/codex:status <job-id>` for one job, `/codex:result --last` for the latest saved result, `/codex:result <job-id>` for an exact result, `/codex:apply <job-id>` for a completed write-task patch, or `/codex:cancel <job-id>` to stop an active job.",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
