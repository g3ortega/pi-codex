import { backgroundJobSubject, isResearchBackgroundJob } from "./job-types.js";
import type { CodexBackgroundJob } from "./job-types.js";

function formatWhen(value: string | undefined): string {
  return value ?? "n/a";
}

export function renderBackgroundJobLaunchMarkdown(job: CodexBackgroundJob): string {
  const title = backgroundJobTitle(job, true);
  const subjectLabel = job.jobClass === "review" ? "Target" : "Request";
  const lines = [
    `# ${title}`,
    "",
    job.jobClass === "review" ? "Background review launched." : "Background research launched.",
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
      : "Use `/codex:status` to track progress, `/codex:result <job-id>` for the final research result, or `/codex:cancel <job-id>` to stop it.",
  ];

  if (job.jobClass === "review" && job.focusText) {
    lines.splice(9, 0, `- Focus: ${job.focusText}`);
  }
  if (isResearchBackgroundJob(job)) {
    lines.push(
      "",
      "Tool surface:",
      `- Safe built-in tools: ${job.safeBuiltinTools.length > 0 ? job.safeBuiltinTools.join(", ") : "none"}`,
      `- Active web tools: ${job.activeWebTools.length > 0 ? job.activeWebTools.join(", ") : "none"}`,
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
  if (isResearchBackgroundJob(job)) {
    lines.push(`- Safe built-in tools: ${job.safeBuiltinTools.length > 0 ? job.safeBuiltinTools.join(", ") : "none"}`);
    lines.push(`- Active web tools: ${job.activeWebTools.length > 0 ? job.activeWebTools.join(", ") : "none"}`);
    lines.push(`- Activated tools: ${job.activeToolNames.length > 0 ? job.activeToolNames.join(", ") : "pending"}`);
    if (job.missingToolNames && job.missingToolNames.length > 0) {
      lines.push(`- Missing requested tools: ${job.missingToolNames.join(", ")}`);
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
      lines.push(job.jobClass === "review" ? "The background review is still in progress." : "The background research job is still in progress.");
      break;
    case "cancelling":
      lines.push(
        job.jobClass === "review"
          ? "Cancellation was requested. Waiting for the background review runner to stop."
          : "Cancellation was requested. Waiting for the background research runner to stop.",
      );
      break;
    case "cancelled":
      lines.push(job.jobClass === "review" ? "The background review was cancelled before completion." : "The background research job was cancelled before completion.");
      break;
    case "lost":
      lines.push(job.jobClass === "review" ? "The background review runner disappeared before it reported a terminal result." : "The background research runner disappeared before it reported a terminal result.");
      break;
    case "failed":
      lines.push(job.jobClass === "review" ? "The background review failed before producing a result." : "The background research job failed before producing a result.");
      break;
    case "completed":
      lines.push(
        job.jobClass === "review"
          ? "The background review completed. Use `/codex:result " + job.id + "` to inspect the stored review."
          : "The background research completed. Use `/codex:result " + job.id + "` to inspect the stored result.",
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

export function backgroundJobTitle(job: CodexBackgroundJob, includeJobSuffix = false): string {
  const base = job.jobClass === "review"
    ? (job.kind === "adversarial-review" ? "Codex Adversarial Review" : "Codex Review")
    : "Codex Research";
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
): string {
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

  if (summaryText?.trim()) {
    lines.push("", "Summary:", "", summarizeText(summaryText));
  } else if (job.errorMessage?.trim()) {
    lines.push("", "Error:", "", summarizeText(job.errorMessage));
  }

  lines.push(
    "",
    job.jobClass === "review"
      ? `Use \`/codex:result ${job.id}\` for the full stored review.`
      : `Use \`/codex:result ${job.id}\` for the full stored research result.`,
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderBackgroundJobsOverviewMarkdown(jobs: CodexBackgroundJob[]): string {
  if (jobs.length === 0) {
    return "# Codex Status\n\nNo background Codex jobs for this workspace yet.\n";
  }

  const lines = [
    "# Codex Status",
    "",
    "| Job ID | Kind | Status | Phase | Verdict | Branch | Subject | Updated |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const job of jobs) {
    lines.push(
      `| ${job.id} | ${job.kind} | ${job.status} | ${job.phase} | ${job.jobClass === "review" ? job.resultVerdict ?? "-" : "-"} | ${job.branch} | ${backgroundJobSubject(job).replace(/\|/g, "\\|")} | ${formatWhen(job.updatedAt)} |`,
    );
  }

  lines.push("", "Use `/codex:status <job-id>` for a single job, `/codex:result <job-id>` for the stored result, or `/codex:cancel <job-id>` to stop an active job.");
  return `${lines.join("\n").trimEnd()}\n`;
}
