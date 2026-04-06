import type { CodexSettings } from "../config/codex-settings.js";
import type { ResearchToolSnapshot } from "../runtime/session-prompts.js";
import { summarizeBackgroundDurations, summarizeReviewDuration } from "../runtime/duration.js";
import type { StoredReviewRun, StructuredReviewResult } from "./review-schema.js";
import { reviewKindTitle } from "./review-kind.js";

function formatLineRange(lineStart: number | null, lineEnd: number | null): string {
  if (!lineStart) {
    return "";
  }
  if (!lineEnd || lineEnd === lineStart) {
    return `:${lineStart}`;
  }
  return `:${lineStart}-${lineEnd}`;
}

function findingsMarkdown(result: StructuredReviewResult): string[] {
  if (result.findings.length === 0) {
    return ["No material findings."];
  }

  const lines: string[] = [];
  for (const finding of result.findings) {
    lines.push(`- ${finding.severity.toUpperCase()}: ${finding.title} (${finding.file}${formatLineRange(finding.line_start, finding.line_end)})`);
    lines.push(`  ${finding.body}`);
    if (finding.recommendation) {
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
    if (finding.confidence !== null) {
      lines.push(`  Confidence: ${finding.confidence.toFixed(2)}`);
    }
  }
  return lines;
}

export function renderStoredReviewMarkdown(
  run: StoredReviewRun,
  options: {
    backgroundTiming?: {
      createdAt?: string;
      startedAt?: string;
      completedAt?: string;
      cancelledAt?: string;
      updatedAt?: string;
      status?: string;
    };
  } = {},
): string {
  const duration = summarizeReviewDuration(run);
  const backgroundTimings = options.backgroundTiming ? summarizeBackgroundDurations(options.backgroundTiming) : null;
  const header = [
    `# ${reviewKindTitle(run.kind)}`,
    "",
    `- Review ID: ${run.id}`,
    `- Repository: ${run.repoRoot}`,
    `- Branch: ${run.branch}`,
    `- Target: ${run.targetLabel}`,
    `- Model: ${run.modelProvider}/${run.modelId}`,
    `- Thinking: ${run.thinkingLevel ?? "off"}`,
    `- Created: ${run.createdAt}`,
  ];
  if (run.completedAt && run.completedAt !== run.createdAt) {
    header.push(`- Completed: ${run.completedAt}`);
  }
  if (backgroundTimings?.queueDelay) {
    header.push(`- Queue delay: ${backgroundTimings.queueDelay}`);
  }
  if (backgroundTimings?.runDuration) {
    header.push(`- Run duration: ${backgroundTimings.runDuration}`);
  }
  if (backgroundTimings?.totalDuration) {
    header.push(`- Total duration: ${backgroundTimings.totalDuration}`);
  } else if (duration) {
    header.push(`- Duration: ${duration}`);
  }

  if (run.focusText) {
    header.push(`- Focus: ${run.focusText}`);
  }

  if (!run.result) {
    return [
      ...header,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `Parse error: ${run.parseError ?? "Unknown parse error"}`,
      "",
      "Raw output:",
      "",
      "```text",
      run.rawOutput.trim(),
      "```",
      "",
    ].join("\n");
  }

  const lines = [
    ...header,
    "",
    `Verdict: ${run.result.verdict}`,
    "",
    run.result.summary,
    "",
    "Findings:",
    ...findingsMarkdown(run.result),
  ];

  const ruledOut = run.result.ruled_out ?? [];
  if (ruledOut.length > 0) {
    lines.push("", "Ruled out:");
    for (const item of ruledOut) {
      lines.push(`- ${item}`);
    }
  }

  const uncertainties = run.result.uncertainties ?? [];
  if (uncertainties.length > 0) {
    lines.push("", "Uncertainties:");
    for (const item of uncertainties) {
      lines.push(`- ${item}`);
    }
  }

  const nextSteps = run.result.next_steps ?? [];
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewStatusMarkdown(runs: StoredReviewRun[]): string {
  if (runs.length === 0) {
    return "# Codex Review Status\n\nNo stored reviews for this workspace yet.\n";
  }

  const lines = [
    "# Codex Review Status",
    "",
    "| Review ID | Kind | Verdict | Branch | Target | Created |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const run of runs) {
    const verdict = run.result?.verdict ?? "parse-error";
    lines.push(
      `| ${run.id} | ${run.kind} | ${verdict} | ${run.branch} | ${run.targetLabel.replace(/\|/g, "\\|")} | ${run.createdAt} |`,
    );
  }

  lines.push("", "Use `/codex:result <review-id>` to inspect a stored review.");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskQueuedMarkdown(
  request: string,
  queued: boolean,
  options: { readOnly?: boolean; ignoredModelSpec?: string; appliedThinkingLevel?: string } = {},
): string {
  const lines = [
    "# Codex Task",
    "",
    queued
      ? "The Codex-style task has been queued as a follow-up in the current PI session."
      : "The Codex-style task has been injected into the current PI session.",
    ...(options.readOnly
      ? [
        "",
        "Mode:",
        "",
        "Read-only. This task will inspect, diagnose, or propose a patch, but it should not edit files in the current session.",
      ]
      : []),
    ...(options.ignoredModelSpec
      ? [
        "",
        "Model override:",
        "",
        `\`${options.ignoredModelSpec}\` was treated as a host-side flag and not forwarded into the task text. Inline \`/codex:task\` still uses the current PI session model.`,
      ]
      : []),
    ...(options.appliedThinkingLevel
      ? [
        "",
        "Thinking override:",
        "",
        `This inline task will use the current PI session with a temporary thinking level of \`${options.appliedThinkingLevel}\` for the injected turn only.`,
      ]
      : []),
    "",
    "Request:",
    "",
    request.trim(),
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderResearchQueuedMarkdown(
  request: string,
  queued: boolean,
  snapshot: ResearchToolSnapshot,
  appliedThinkingLevel?: string,
): string {
  const lines = [
    "# Codex Research",
    "",
    queued
      ? "The Codex-style research request has been queued as a follow-up in the current PI session."
      : "The Codex-style research request has been injected into the current PI session.",
    "",
    "Request:",
    "",
    request.trim(),
    "",
    "Active research tools:",
    `- Web: ${snapshot.activeWebTools.length > 0 ? snapshot.activeWebTools.join(", ") : "none"}`,
    `- Local evidence: ${snapshot.activeLocalEvidenceTools.length > 0 ? snapshot.activeLocalEvidenceTools.join(", ") : "none"}`,
  ];

  if (appliedThinkingLevel) {
    lines.push("", "Thinking override:", `- Temporary inline thinking level: ${appliedThinkingLevel}`);
  }

  if (snapshot.inactiveAvailableWebTools.length > 0) {
    lines.push(`- Installed but inactive web tools: ${snapshot.inactiveAvailableWebTools.join(", ")}`);
    lines.push("", "Enable them with `/tools` if you want live web-grounded research in this session.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderConfigMarkdown(
  settings: CodexSettings,
  currentModelLabel: string | null,
  currentThinkingLevel?: string | null,
): string {
  const lines = [
    "# Codex Config",
    "",
    `- Current session model: ${currentModelLabel ?? "none"}`,
    `- Current session thinking: ${currentThinkingLevel ?? "n/a"}`,
    `- Default review scope: ${settings.defaultReviewScope}`,
    `- Default review model: ${settings.defaultReviewModel ?? "(use current session model)"}`,
    `- Review history limit: ${settings.reviewHistoryLimit}`,
    `- Protect lockfiles: ${settings.protectLockfiles ? "on" : "off"}`,
    `- Enable task command: ${settings.enableTaskCommand ? "on" : "off"}`,
    `- Enable research command: ${settings.enableResearchCommand ? "on" : "off"}`,
    "",
    "Protected paths:",
    ...settings.protectedPaths.map((entry) => `- ${entry}`),
    "",
    "Use `/extension-settings` to modify the global extension-backed values.",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}
