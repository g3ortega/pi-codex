import type { TaskBackgroundJob, TaskJobResultPayload } from "../runtime/job-types.js";
import { summarizeBackgroundDurations } from "../runtime/duration.js";

function bulletList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

export function renderStoredTaskMarkdown(job: TaskBackgroundJob, result: TaskJobResultPayload): string {
  const timings = summarizeBackgroundDurations(job);
  const lines = [
    "# Codex Task",
    "",
    `- Job ID: ${job.id}`,
    `- Mode: ${job.profile}`,
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
    result.request,
    "",
    "Background tool surface:",
    ...bulletList(result.activeToolNames.map((value) => `Active: ${value}`)),
  );

  if (result.missingToolNames.length > 0) {
    lines.push("", "Missing requested tools:", ...bulletList(result.missingToolNames));
  }

  if (job.profile === "write") {
    lines.push(
      "",
      "Write-worker artifacts:",
      `- Patch file: ${result.patchFile ?? job.patchFile ?? "none"}`,
      `- Files changed: ${String(result.filesChanged ?? job.filesChanged ?? 0)}`,
      `- Insertions: ${String(result.insertions ?? job.insertions ?? 0)}`,
      `- Deletions: ${String(result.deletions ?? job.deletions ?? 0)}`,
    );
    if ((result.diffStat ?? job.diffStat)?.trim()) {
      lines.push("", "Diff stat:", "", result.diffStat ?? job.diffStat ?? "");
    }
    lines.push("", `Apply this stored patch to the live repository with \`/codex:apply ${job.id}\`.`);
  }

  lines.push("", "Final answer:", "", result.finalText.trim());
  return `${lines.join("\n").trimEnd()}\n`;
}
