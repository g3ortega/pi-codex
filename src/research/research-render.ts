import type { ResearchBackgroundJob, ResearchJobResultPayload } from "../runtime/job-types.js";

function bulletList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

export function renderStoredResearchMarkdown(job: ResearchBackgroundJob, result: ResearchJobResultPayload): string {
  const lines = [
    "# Codex Research",
    "",
    `- Job ID: ${job.id}`,
    `- Repository: ${job.repoRoot}`,
    `- Branch: ${job.branch}`,
    `- Model: ${job.modelSpec}`,
    `- Created: ${job.createdAt}`,
  ];

  if (job.startedAt) {
    lines.push(`- Started: ${job.startedAt}`);
  }
  if (job.completedAt) {
    lines.push(`- Completed: ${job.completedAt}`);
  }

  lines.push(
    "",
    "Request:",
    "",
    job.request,
    "",
    "Background tool surface:",
    ...bulletList(result.activeToolNames.map((value) => `Active: ${value}`)),
  );

  if (result.missingToolNames.length > 0) {
    lines.push("", "Missing requested tools:", ...bulletList(result.missingToolNames));
  }

  lines.push("", "Final answer:", "", result.finalText.trim());
  return `${lines.join("\n").trimEnd()}\n`;
}
