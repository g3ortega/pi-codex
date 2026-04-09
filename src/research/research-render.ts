import type { ResearchBackgroundJob, ResearchJobResultPayload } from "../runtime/job-types.js";
import { summarizeBackgroundDurations } from "../runtime/duration.js";

function bulletList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

export function renderStoredResearchMarkdown(job: ResearchBackgroundJob, result: ResearchJobResultPayload): string {
  const timings = summarizeBackgroundDurations(job);
  const lines = [
    "# Codex Research",
    "",
    `- Job ID: ${job.id}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- Model: ${job.modelSpec}`,
    `- Thinking: ${job.thinkingLevel ?? "off"}`,
    `- Created: ${job.createdAt}`,
  ];

  if (job.startedAt) {
    lines.push(`- Started: ${job.startedAt}`);
  }
  if (job.completedAt) {
    lines.push(`- Completed: ${job.completedAt}`);
  }
  if (timings.queueDelay) {
    lines.push(`- Queue delay: ${timings.queueDelay}`);
  }
  if (timings.runDuration) {
    lines.push(`- Run duration: ${timings.runDuration}`);
  }
  if (timings.totalDuration) {
    lines.push(`- Total duration: ${timings.totalDuration}`);
  }

  lines.push(
    "",
    "Request:",
    "",
    job.request,
    "",
    "Tools used in the background worker:",
    `- Native Codex web search: ${job.nativeWebSearchEnabled ? "enabled" : "disabled"}`,
    ...bulletList(result.activeToolNames.map((value) => `Active: ${value}`)),
  );

  if (result.missingToolNames.length > 0) {
    lines.push("", "Missing requested tools:", ...bulletList(result.missingToolNames));
  }

  lines.push("", "Final answer:", "", result.finalText.trim());
  return `${lines.join("\n").trimEnd()}\n`;
}
