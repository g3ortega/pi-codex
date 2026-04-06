import { backgroundJobSubject, isResearchBackgroundJob, isTaskBackgroundJob } from "./job-types.js";
import type { CodexBackgroundJob } from "./job-types.js";

const INLINE_COMPLETION_MAX_CHARS = 2_400;
const INLINE_COMPLETION_MAX_LINES = 48;

function formatWhen(value: string | undefined): string {
  return value ?? "n/a";
}

export function renderBackgroundJobLaunchMarkdown(job: CodexBackgroundJob): string {
  const title = backgroundJobTitle(job, true);
  const subjectLabel = job.jobClass === "review" ? "Target" : "Request";
  const lines = [
    `# ${title}`,
    "",
    job.jobClass === "review"
      ? "Background review launched."
      : job.jobClass === "research"
        ? "Background research launched."
        : job.profile === "write"
          ? "Background write task launched in an isolated worktree."
          : "Background readonly task launched.",
    "",
    `- Job ID: ${job.id}`,
    `- Status: ${job.status}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- ${subjectLabel}: ${backgroundJobSubject(job)}`,
    `- Model: ${job.modelSpec}`,
    `- Created: ${job.createdAt}`,
    "",
    job.jobClass === "review"
      ? "Use `/codex:status` to track progress, `/codex:result <job-id>` for the final review, or `/codex:cancel <job-id>` to stop it."
      : job.jobClass === "research"
        ? "Use `/codex:status` to track progress, `/codex:result <job-id>` for the final research result, or `/codex:cancel <job-id>` to stop it."
        : job.profile === "write"
          ? "Use `/codex:status` to track progress, `/codex:result <job-id>` for the final task result, `/codex:apply <job-id>` to apply the stored patch, or `/codex:cancel <job-id>` to stop it."
          : "Use `/codex:status` to track progress, `/codex:result <job-id>` for the final task result, or `/codex:cancel <job-id>` to stop it.",
  ];

  if (job.jobClass === "review" && job.focusText) {
    lines.splice(9, 0, `- Focus: ${job.focusText}`);
  }
  if (isTaskBackgroundJob(job)) {
    lines.push(`- Mode: ${job.profile}`);
  }
  if (isResearchBackgroundJob(job) || isTaskBackgroundJob(job)) {
    lines.push(
      "",
      "Tool surface:",
      `- Worker built-in tools: ${job.safeBuiltinTools.length > 0 ? job.safeBuiltinTools.join(", ") : "none"}`,
      `- Active web tools: ${job.activeWebTools.length > 0 ? job.activeWebTools.join(", ") : "none"}`,
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
  if (job.jobClass === "review" && job.focusText) {
    lines.push(`- Focus: ${job.focusText}`);
  }
  if (job.jobClass === "review" && job.resultVerdict) {
    lines.push(`- Verdict: ${job.resultVerdict}`);
  }
  if (isTaskBackgroundJob(job)) {
    lines.push(`- Mode: ${job.profile}`);
  }
  if (isResearchBackgroundJob(job) || isTaskBackgroundJob(job)) {
    lines.push(`- Worker built-in tools: ${job.safeBuiltinTools.length > 0 ? job.safeBuiltinTools.join(", ") : "none"}`);
    lines.push(`- Active web tools: ${job.activeWebTools.length > 0 ? job.activeWebTools.join(", ") : "none"}`);
    lines.push(`- Activated tools: ${job.activeToolNames.length > 0 ? job.activeToolNames.join(", ") : "pending"}`);
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
          ? "The background review is still in progress."
          : job.jobClass === "research"
            ? "The background research job is still in progress."
            : job.profile === "write"
              ? "The background write task is still in progress inside its isolated worktree."
              : "The background readonly task is still in progress.",
      );
      break;
    case "cancelling":
      lines.push(
        job.jobClass === "review"
          ? "Cancellation was requested. Waiting for the background review runner to stop."
          : job.jobClass === "research"
            ? "Cancellation was requested. Waiting for the background research runner to stop."
            : job.profile === "write"
              ? "Cancellation was requested. Waiting for the isolated background write worker to stop."
              : "Cancellation was requested. Waiting for the background task runner to stop.",
      );
      break;
    case "cancelled":
      lines.push(
        job.jobClass === "review"
          ? "The background review was cancelled before completion."
          : job.jobClass === "research"
            ? "The background research job was cancelled before completion."
            : job.profile === "write"
              ? "The background write task was cancelled before completion."
              : "The background readonly task was cancelled before completion.",
      );
      break;
    case "lost":
      lines.push(
        job.jobClass === "review"
          ? "The background review runner disappeared before it reported a terminal result."
          : job.jobClass === "research"
            ? "The background research runner disappeared before it reported a terminal result."
            : job.profile === "write"
              ? "The background write worker disappeared before it reported a terminal result."
              : "The background task runner disappeared before it reported a terminal result.",
      );
      break;
    case "failed":
      lines.push(
        job.jobClass === "review"
          ? "The background review failed before producing a result."
          : job.jobClass === "research"
            ? "The background research job failed before producing a result."
            : job.profile === "write"
              ? "The background write task failed before producing a result."
              : "The background readonly task failed before producing a result.",
      );
      break;
    case "completed":
      lines.push(
        job.jobClass === "review"
          ? "The background review completed. Use `/codex:result " + job.id + "` to inspect the stored review."
          : job.jobClass === "research"
            ? "The background research completed. Use `/codex:result " + job.id + "` to inspect the stored result."
            : job.profile === "write"
              ? "The background write task completed in an isolated worktree. Use `/codex:result " + job.id + "` to inspect the stored result and patch artifact, or `/codex:apply " + job.id + "` to apply it to the live repository."
              : "The background readonly task completed. Use `/codex:result " + job.id + "` to inspect the stored result.",
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
    ? `Use \`/codex:result ${job.id}\` for the full stored review.`
    : job.jobClass === "research"
      ? `Use \`/codex:result ${job.id}\` for the full stored research result.`
      : job.profile === "write"
        ? `Use \`/codex:result ${job.id}\` for the full stored task result or \`/codex:apply ${job.id}\` to apply the stored patch.`
        : `Use \`/codex:result ${job.id}\` for the full stored task result.`;
}

export function backgroundJobTitle(job: CodexBackgroundJob, includeJobSuffix = false): string {
  const base = job.jobClass === "review"
    ? (job.kind === "adversarial-review" ? "Codex Adversarial Review" : "Codex Review")
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

  lines.push("", "Use `/codex:status <job-id>` for a single job, `/codex:result <job-id>` for the stored result, `/codex:apply <job-id>` for completed write-task patches, or `/codex:cancel <job-id>` to stop an active job.");
  return `${lines.join("\n").trimEnd()}\n`;
}
