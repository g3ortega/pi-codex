import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";

import { loadCodexSettings, registerCodexSettings } from "../../src/config/codex-settings.js";
import { launchBackgroundReviewJob, runDetachedReviewJob, internalReviewJobCommandName } from "../../src/background/review-job.js";
import {
  internalResearchJobCommandName,
  launchBackgroundResearchJob,
  runDetachedResearchJob,
} from "../../src/background/research-job.js";
import {
  internalTaskJobCommandName,
  launchBackgroundReadonlyTaskJob,
  launchBackgroundWriteTaskJob,
  runDetachedTaskJob,
} from "../../src/background/task-job.js";
import { splitLeadingOptionTokens, splitShellLikeArgs } from "../../src/runtime/arg-parser.js";
import { detectBuiltinAlternativeForBash } from "../../src/runtime/bash-alternatives.js";
import {
  cancelBackgroundJob,
  findBackgroundJob,
  listBackgroundJobs,
  readBackgroundJobResultMarkdown,
} from "../../src/runtime/job-store.js";
import { applyStoredTaskPatch } from "../../src/runtime/patch-apply.js";
import {
  backgroundJobReportVariant,
  renderBackgroundJobLaunchMarkdown,
  renderBackgroundJobMarkdown,
  renderBackgroundJobsOverviewMarkdown,
} from "../../src/runtime/job-render.js";
import { REPORT_TYPE, sendReport, type ReportDetails } from "../../src/runtime/report-message.js";
import { parseTaskCommandOptions } from "../../src/runtime/task-command-options.js";
import { findProtectedPathInBashCommand, findProtectedPathMatch } from "../../src/runtime/path-protection.js";
import { buildInspectionRetryGuidance, buildResearchPrompt, buildTaskPrompt, inspectResearchTools } from "../../src/runtime/session-prompts.js";
import { executeReviewRun, type ReviewCommandOptions } from "../../src/review/review-runner.js";
import { findStoredReview, listStoredReviews } from "../../src/runtime/review-store.js";
import {
  renderConfigMarkdown,
  renderResearchQueuedMarkdown,
  renderReviewStatusMarkdown,
  renderStoredReviewMarkdown,
  renderTaskQueuedMarkdown,
} from "../../src/review/review-render.js";

const IS_PRINT_MODE = process.argv.includes("-p") || process.argv.includes("--print");
const LEGACY_PROMPT_ALIAS_TITLES: Record<string, string> = {
  "codex-review": "Codex Review",
  "codex-adversarial-review": "Codex Adversarial Review",
  "codex-task": "Codex Task",
  "codex-research": "Codex Research",
};

function reportThemeName(variant: ReportDetails["variant"]): "customMessageBg" | "toolSuccessBg" | "toolPendingBg" | "toolErrorBg" {
  switch (variant) {
    case "success":
      return "toolSuccessBg";
    case "warning":
      return "toolPendingBg";
    case "error":
      return "toolErrorBg";
    default:
      return "customMessageBg";
  }
}

function createInjectedTurnWaiter() {
  let resolveWaiter: (() => void) | null = null;
  let settled = false;

  return {
    promise: new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    }),
    resolve() {
      if (settled) {
        return;
      }
      settled = true;
      resolveWaiter?.();
    },
  };
}

type InjectedTurnWaiter = ReturnType<typeof createInjectedTurnWaiter>;

function parseSlashInput(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1);
  const spaceIndex = body.indexOf(" ");
  if (spaceIndex === -1) {
    return { name: body, args: "" };
  }

  return {
    name: body.slice(0, spaceIndex),
    args: body.slice(spaceIndex + 1).trim(),
  };
}

function buildLegacyPromptAliasGuidance(name: string, args: string): { title: string; markdown: string } | null {
  const title = LEGACY_PROMPT_ALIAS_TITLES[name];
  if (!title) {
    return null;
  }

  const suffix = args ? ` ${args}` : "";
  const workflowCommand =
    name === "codex-review" && args ? `/codex:adversarial-review${suffix}` : `/codex:${name.slice("codex-".length)}${suffix}`;
  const promptReference = `references/prompts/${name.replace(/^codex-/, "codex-prompt-")}.md`;

  return {
    title,
    markdown: [
      `# ${title}`,
      "",
      `\`/${name}\` is intentionally disabled to avoid confusion with the packaged workflow commands and to prevent accidental shell-confirmation flows.`,
      "",
      `Use \`${workflowCommand}\` for the packaged workflow.`,
      `The lightweight reference prompt for this workflow lives at \`${promptReference}\` in the package source and is not auto-registered as a PI prompt.`,
    ].join("\n"),
  };
}

function parseReviewCommandOptions(rawArgs: string): ReviewCommandOptions {
  const tokens = splitShellLikeArgs(rawArgs);
  const { optionTokens, remainderTokens } = splitLeadingOptionTokens(tokens, ["--scope", "--base", "--model"]);
  const options: ReviewCommandOptions = {};
  const focus: string[] = [...remainderTokens];

  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index];
    if (token === "--background") {
      options.background = true;
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token === "--scope") {
      const next = optionTokens[index + 1];
      if (!next || (next !== "auto" && next !== "working-tree" && next !== "branch")) {
        throw new Error("`--scope` must be one of: auto, working-tree, branch.");
      }
      options.scope = next;
      index += 1;
      continue;
    }
    if (token === "--base") {
      const next = optionTokens[index + 1];
      if (!next) {
        throw new Error("`--base` requires a git ref.");
      }
      options.base = next;
      index += 1;
      continue;
    }
    if (token === "--model") {
      const next = optionTokens[index + 1];
      if (!next) {
        throw new Error("`--model` requires provider/modelId.");
      }
      options.modelSpec = next;
      index += 1;
      continue;
    }
    focus.push(...optionTokens.slice(index));
    break;
  }

  const focusText = focus.join(" ").trim();
  if (focusText) {
    options.focusText = focusText;
  }

  return options;
}

function parseResearchCommandOptions(rawArgs: string): { background: boolean; modelSpec?: string; request: string } {
  const tokens = splitShellLikeArgs(rawArgs);
  const { optionTokens, remainderTokens } = splitLeadingOptionTokens(tokens, ["--model"]);
  const request: string[] = [...remainderTokens];
  let background = false;
  let modelSpec: string | undefined;

  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index];
    if (token === "--background") {
      background = true;
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token === "--model") {
      const next = optionTokens[index + 1];
      if (!next) {
        throw new Error("`--model` requires provider/modelId.");
      }
      modelSpec = next;
      index += 1;
      continue;
    }
    request.push(...optionTokens.slice(index));
    break;
  }

  return {
    background,
    modelSpec,
    request: request.join(" ").trim(),
  };
}

async function handleReviewCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  kind: "review" | "adversarial-review",
  rawArgs: string,
): Promise<void> {
  const settings = loadCodexSettings(ctx.cwd);
  const options = parseReviewCommandOptions(rawArgs);
  if (kind === "review" && options.focusText) {
    throw new Error(
      `\`/codex:review\` stays non-steerable. Retry with \`/codex:adversarial-review ${options.focusText}\` for focused review instructions.`,
    );
  }
  if (options.background) {
    const job = await launchBackgroundReviewJob(ctx, settings, kind, options);
    sendReport(
      pi,
      kind === "adversarial-review" ? "Codex Adversarial Review Job" : "Codex Review Job",
      renderBackgroundJobLaunchMarkdown(job),
      "info",
    );
    return;
  }
  const run = await executeReviewRun(ctx, settings, kind, options);
  sendReport(
    pi,
    kind === "adversarial-review" ? "Codex Adversarial Review" : "Codex Review",
    renderStoredReviewMarkdown(run),
    run.result?.verdict === "needs-attention" || !run.result ? "warning" : "success",
  );
}

async function handleTaskCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<boolean> {
  const settings = loadCodexSettings(ctx.cwd);
  if (!settings.enableTaskCommand) {
    sendReport(pi, "Codex Task", "# Codex Task\n\nThe task command is disabled in the current Codex settings.\n", "warning");
    return false;
  }

  const options = parseTaskCommandOptions(rawArgs);
  const request = options.request;
  if (!request) {
    sendReport(pi, "Codex Task", "# Codex Task\n\nProvide a request, for example `/codex:task investigate why auth refresh fails`.\n", "warning");
    return false;
  }

  if (options.background) {
    const job = options.profile === "readonly"
      ? await launchBackgroundReadonlyTaskJob(pi, ctx, settings, request, options.modelSpec)
      : await launchBackgroundWriteTaskJob(pi, ctx, settings, request, options.modelSpec);
    sendReport(
      pi,
      "Codex Task Job",
      renderBackgroundJobLaunchMarkdown(job),
      "info",
    );
    return false;
  }

  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  pi.sendUserMessage(
    buildTaskPrompt(request, pi.getActiveTools(), {
      readOnly: options.profile === "readonly",
      activeWebTools: inspectResearchTools(pi).activeWebTools,
    }),
    deliverAs ? { deliverAs } : undefined,
  );
  sendReport(
    pi,
    "Codex Task",
    renderTaskQueuedMarkdown(request, deliverAs === "followUp", {
      readOnly: options.profile === "readonly",
      ignoredModelSpec: options.modelSpec,
    }),
    "info",
  );
  return true;
}

async function handleResearchCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<boolean> {
  const settings = loadCodexSettings(ctx.cwd);
  if (!settings.enableResearchCommand) {
    sendReport(pi, "Codex Research", "# Codex Research\n\nThe research command is disabled in the current Codex settings.\n", "warning");
    return false;
  }

  const options = parseResearchCommandOptions(rawArgs);
  const request = options.request;
  if (!request) {
    sendReport(
      pi,
      "Codex Research",
      "# Codex Research\n\nProvide a request, for example `/codex:research compare PI extension APIs with Codex CLI and verify current web tooling support`.\n",
      "warning",
    );
    return false;
  }

  if (options.background) {
    const job = await launchBackgroundResearchJob(pi, ctx, settings, request, options.modelSpec);
    sendReport(pi, "Codex Research Job", renderBackgroundJobLaunchMarkdown(job), "info");
    return false;
  }

  const snapshot = inspectResearchTools(pi);
  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  pi.sendUserMessage(buildResearchPrompt(request, snapshot), deliverAs ? { deliverAs } : undefined);
  sendReport(pi, "Codex Research", renderResearchQueuedMarkdown(request, deliverAs === "followUp", snapshot), "info");
  return true;
}

async function runTaskCommandWithWaiter(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  pendingInjectedTurnWaiters: InjectedTurnWaiter[],
): Promise<void> {
  const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
  if (waiter) {
    pendingInjectedTurnWaiters.push(waiter);
  }

  try {
    const injected = await handleTaskCommand(pi, ctx, args);
    if (waiter && injected) {
      await waiter.promise;
    }
  } finally {
    if (waiter) {
      const index = pendingInjectedTurnWaiters.indexOf(waiter);
      if (index >= 0) {
        pendingInjectedTurnWaiters.splice(index, 1);
      }
      waiter.resolve();
    }
  }
}

async function runResearchCommandWithWaiter(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  pendingInjectedTurnWaiters: InjectedTurnWaiter[],
): Promise<void> {
  const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
  if (waiter) {
    pendingInjectedTurnWaiters.push(waiter);
  }

  try {
    const injected = await handleResearchCommand(pi, ctx, args);
    if (waiter && injected) {
      await waiter.promise;
    }
  } finally {
    if (waiter) {
      const index = pendingInjectedTurnWaiters.indexOf(waiter);
      if (index >= 0) {
        pendingInjectedTurnWaiters.splice(index, 1);
      }
      waiter.resolve();
    }
  }
}

async function dispatchCodexCommandByName(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
  args: string,
  pendingInjectedTurnWaiters: InjectedTurnWaiter[],
): Promise<boolean> {
  switch (name) {
    case "codex:review":
      await handleReviewCommand(pi, ctx, "review", args);
      return true;
    case "codex:adversarial-review":
      await handleReviewCommand(pi, ctx, "adversarial-review", args);
      return true;
    case "codex:task":
      await runTaskCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters);
      return true;
    case "codex:research":
      await runResearchCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters);
      return true;
    case "codex:status":
    case "codex-status":
      await handleStatusCommand(pi, ctx, args);
      return true;
    case "codex:result":
    case "codex-result":
      await handleResultCommand(pi, ctx, args);
      return true;
    case "codex:cancel":
    case "codex-cancel":
      await handleCancelCommand(pi, ctx, args);
      return true;
    case "codex:jobs":
    case "codex-jobs":
      await handleJobsCommand(pi, ctx);
      return true;
    case "codex:apply":
    case "codex-apply":
      await handleApplyCommand(pi, ctx, args);
      return true;
    case "codex:config":
    case "codex-config":
      await handleConfigCommand(pi, ctx);
      return true;
    default:
      return false;
  }
}

async function handleStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const reference = rawArgs.trim() || undefined;
  let job = null;
  try {
    job = findBackgroundJob(ctx.cwd, reference, { preferActive: Boolean(reference) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Status", `# Codex Status\n\n${message}\n`, "warning");
    return;
  }
  if (job) {
    sendReport(pi, "Codex Job Status", renderBackgroundJobMarkdown(job), backgroundJobReportVariant(job));
    return;
  }

  if (reference) {
    let run = null;
    try {
      run = findStoredReview(ctx.cwd, reference);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendReport(pi, "Codex Status", `# Codex Status\n\n${message}\n`, "warning");
      return;
    }
    if (!run) {
      sendReport(pi, "Codex Status", `# Codex Status\n\nNo background job or stored review matches \`${reference}\` for this workspace.\n`, "warning");
      return;
    }
    sendReport(pi, "Codex Result", renderStoredReviewMarkdown(run), "info");
    return;
  }

  const jobs = listBackgroundJobs(ctx.cwd);
  if (jobs.length > 0) {
    sendReport(pi, "Codex Status", renderBackgroundJobsOverviewMarkdown(jobs, "Codex Status"), "info");
    return;
  }

  const runs = listStoredReviews(ctx.cwd).slice(0, loadCodexSettings(ctx.cwd).reviewHistoryLimit);
  sendReport(pi, "Codex Review Status", renderReviewStatusMarkdown(runs), "info");
}

async function handleResultCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const reference = rawArgs.trim() || undefined;
  let job = null;
  try {
    job = findBackgroundJob(ctx.cwd, reference);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Result", `# Codex Result\n\n${message}\n`, "warning");
    return;
  }
  if (job) {
    const markdown = readBackgroundJobResultMarkdown(job.workspaceRoot, job.id);
    if (markdown) {
      sendReport(pi, "Codex Result", markdown, backgroundJobReportVariant(job));
      return;
    }

    sendReport(
      pi,
      "Codex Result",
      renderBackgroundJobMarkdown(job),
      backgroundJobReportVariant(job),
    );
    return;
  }

  let run = null;
  try {
    run = findStoredReview(ctx.cwd, reference);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Result", `# Codex Result\n\n${message}\n`, "warning");
    return;
  }
  if (!run) {
    sendReport(pi, "Codex Result", "# Codex Result\n\nNo stored background job result or foreground review result is available for this workspace.\n", "warning");
    return;
  }
  sendReport(pi, "Codex Result", renderStoredReviewMarkdown(run), "info");
}

async function handleCancelCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  let cancelled = null;
  try {
    cancelled = cancelBackgroundJob(ctx.cwd, rawArgs.trim() || undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Cancel", `# Codex Cancel\n\n${message}\n`, "warning");
    return;
  }
  if (!cancelled) {
    sendReport(pi, "Codex Cancel", "# Codex Cancel\n\nNo active background Codex job is available to cancel in this workspace.\n", "warning");
    return;
  }

  sendReport(pi, "Codex Cancel", renderBackgroundJobMarkdown(cancelled), "warning");
}

async function handleJobsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const jobs = listBackgroundJobs(ctx.cwd);
  sendReport(pi, "Codex Jobs", renderBackgroundJobsOverviewMarkdown(jobs, "Codex Jobs"), "info");
}

async function handleApplyCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const reference = rawArgs.trim();
  if (!reference) {
    sendReport(pi, "Codex Apply", "# Codex Apply\n\nProvide a background write-task job id, for example `/codex:apply task-m123abc`.\n", "warning");
    return;
  }

  let job = null;
  try {
    job = findBackgroundJob(ctx.cwd, reference);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Apply", `# Codex Apply\n\n${message}\n`, "warning");
    return;
  }

  if (!job) {
    sendReport(pi, "Codex Apply", `# Codex Apply\n\nNo background Codex job matches \`${reference}\` for this workspace.\n`, "warning");
    return;
  }
  if (job.jobClass !== "task" || job.profile !== "write") {
    sendReport(pi, "Codex Apply", "# Codex Apply\n\nOnly completed background `task-write` jobs can be applied back to the live repository.\n", "warning");
    return;
  }

  try {
    const applied = applyStoredTaskPatch(ctx.cwd, job);
    const lines = [
      "# Codex Apply",
      "",
      "Applied the stored background write-task patch to the live repository.",
      "",
      `- Job ID: ${job.id}`,
      `- Repository: ${applied.repoRoot}`,
      `- Patch file: ${applied.patchFile}`,
    ];
    if (applied.diffStat.trim()) {
      lines.push("", "Diff stat:", "", applied.diffStat);
    }
    sendReport(pi, "Codex Apply", `${lines.join("\n").trimEnd()}\n`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendReport(pi, "Codex Apply", `# Codex Apply\n\n${message}\n`, "warning");
  }
}

async function handleConfigCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const settings = loadCodexSettings(ctx.cwd);
  const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
  sendReport(pi, "Codex Config", renderConfigMarkdown(settings, currentModel), "info");
}

function registerCommandPair(
  pi: ExtensionAPI,
  name: string,
  alias: string,
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
): void {
  for (const commandName of [name, alias]) {
    pi.registerCommand(commandName, {
      description,
      handler: async (args, ctx) => {
        try {
          await handler(args, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendReport(pi, "Codex Error", `# Codex Error\n\n${message}\n`, "error");
        }
      },
    });
  }
}

function registerSingleCommand(
  pi: ExtensionAPI,
  name: string,
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      try {
        await handler(args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendReport(pi, "Codex Error", `# Codex Error\n\n${message}\n`, "error");
      }
    },
  });
}

export default function registerCodexExtension(pi: ExtensionAPI): void {
  let pendingInjectedTurnWaiters: InjectedTurnWaiter[] = [];

  registerCodexSettings(pi);

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" } as const;
    }

    const slash = parseSlashInput(event.text);
    if (!slash) {
      return { action: "continue" } as const;
    }

    const guidance = buildLegacyPromptAliasGuidance(slash.name, slash.args);
    if (guidance) {
      sendReport(pi, guidance.title, guidance.markdown, "warning");
      return { action: "handled" } as const;
    }

    if (!slash.name.startsWith("codex:") && !slash.name.startsWith("codex-")) {
      return { action: "continue" } as const;
    }

    try {
      const handled = await dispatchCodexCommandByName(
        pi,
        ctx as ExtensionCommandContext,
        slash.name,
        slash.args,
        pendingInjectedTurnWaiters,
      );
      return handled ? ({ action: "handled" } as const) : ({ action: "continue" } as const);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendReport(pi, "Codex Error", `# Codex Error\n\n${message}\n`, "error");
      return { action: "handled" } as const;
    }
  });

  pi.registerMessageRenderer(REPORT_TYPE, (message, _options, theme) => {
    const details = (message.details ?? {}) as ReportDetails;
    const container = new Box(1, 1, (value: string) => theme.bg(reportThemeName(details.variant), value));
    const border = new DynamicBorder((value: string) => theme.fg("accent", value));

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold(details.title || "Codex")), 1, 0));
    container.addChild(new Markdown(String(message.content ?? ""), 1, 1, getMarkdownTheme()));
    if (details.timestamp) {
      container.addChild(new Text(theme.fg("dim", new Date(details.timestamp).toLocaleString()), 1, 0));
    }
    container.addChild(border);
    return container;
  });

  pi.on("session_start", async (_event, ctx) => {
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("pi-codex", theme.fg("dim", "Codex review ready"));
  });

  pi.on("turn_end", async () => {
    if (pendingInjectedTurnWaiters.length === 0) {
      return;
    }

    const waiter = pendingInjectedTurnWaiters.shift();
    waiter?.resolve();
  });

  pi.on("tool_call", async (event, ctx) => {
    const settings = loadCodexSettings(ctx.cwd);
    let blockedTarget: string | null = null;
    let builtinAlternativeReason: string | null = null;

    if (event.toolName === "edit" || event.toolName === "write") {
      const pathValue = String((event.input as { path?: unknown }).path ?? "");
      blockedTarget = findProtectedPathMatch(pathValue, settings.protectedPaths);
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      const builtinAlternative = detectBuiltinAlternativeForBash(command, pi.getActiveTools());
      if (builtinAlternative) {
        builtinAlternativeReason = builtinAlternative.reason;
      }
      blockedTarget = findProtectedPathInBashCommand(command, settings.protectedPaths);
    }

    if (!blockedTarget && !builtinAlternativeReason) {
      return undefined;
    }

    if (ctx.hasUI) {
      if (blockedTarget) {
        ctx.ui.notify(`Blocked mutation of protected path: ${blockedTarget}`, "warning");
      } else if (builtinAlternativeReason) {
        ctx.ui.notify(builtinAlternativeReason, "info");
      }
    }

    if (blockedTarget) {
      return { block: true, reason: `Path "${blockedTarget}" is protected by pi-codex.` };
    }

    return { block: true, reason: builtinAlternativeReason ?? "Use PI's built-in read-only tools instead of bash." };
  });

  pi.on("tool_result", async (event) => {
    if (!event.isError) {
      return undefined;
    }

    const textBody = event.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n")
      .trim();

    if (!textBody.includes("protected by pi-codex")) {
      if (!textBody.includes("built-in `") && !textBody.includes("Use the built-in")) {
        return undefined;
      }

      return {
        content: [
          {
            type: "text",
            text: [
              textBody,
              "",
              "Do not retry the same repository-inspection step with bash.",
              ...buildInspectionRetryGuidance(pi.getActiveTools(), pi.getActiveTools().includes("bash")),
            ].join("\n"),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [
            textBody,
            "",
            "Do not try alternate write paths, shell workarounds, renames, or retries for this protected target.",
            "Stop mutating attempts and explain the limitation to the user instead.",
          ].join("\n"),
        },
      ],
    };
  });

  registerSingleCommand(pi, "codex:review", "Run a structured Codex review for the current repository state", async (args, ctx) => {
    await handleReviewCommand(pi, ctx, "review", args);
  });
  registerSingleCommand(pi, "codex:adversarial-review", "Run an adversarial Codex review for the current repository state", async (args, ctx) => {
    await handleReviewCommand(pi, ctx, "adversarial-review", args);
  });
  registerSingleCommand(pi, "codex:task", "Inject a Codex-style implementation request into the active PI session", async (args, ctx) => {
    await runTaskCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters);
  });
  registerSingleCommand(pi, "codex:research", "Inject a Codex-style research request into the active PI session, adapted to active PI web and evidence tools", async (args, ctx) => {
    await runResearchCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters);
  });
  pi.registerCommand(internalReviewJobCommandName(), {
    description: "Internal pi-codex background review runner",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        throw new Error("Background review runner requires a job id.");
      }
      await runDetachedReviewJob(ctx, loadCodexSettings(ctx.cwd), jobId);
    },
  });
  pi.registerCommand(internalResearchJobCommandName(), {
    description: "Internal pi-codex background research runner",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        throw new Error("Background research runner requires a job id.");
      }
      await runDetachedResearchJob(pi, ctx, loadCodexSettings(ctx.cwd), jobId);
    },
  });
  pi.registerCommand(internalTaskJobCommandName(), {
    description: "Internal pi-codex background task runner",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        throw new Error("Background task runner requires a job id.");
      }
      await runDetachedTaskJob(pi, ctx, loadCodexSettings(ctx.cwd), jobId);
    },
  });
  registerCommandPair(pi, "codex:status", "codex-status", "Show stored Codex review history for the current workspace", async (args, ctx) => {
    await handleStatusCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:result", "codex-result", "Show a stored Codex review result for the current workspace", async (args, ctx) => {
    await handleResultCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:cancel", "codex-cancel", "Cancel an active background Codex job for the current workspace", async (args, ctx) => {
    await handleCancelCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:jobs", "codex-jobs", "List background Codex jobs for the current workspace", async (_args, ctx) => {
    await handleJobsCommand(pi, ctx);
  });
  registerCommandPair(pi, "codex:apply", "codex-apply", "Apply a stored background task-write patch to the live repository", async (args, ctx) => {
    await handleApplyCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:config", "codex-config", "Show the merged Codex configuration for this PI session", async (_args, ctx) => {
    await handleConfigCommand(pi, ctx);
  });
}
