import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";

import { loadCodexSettings, registerCodexSettings } from "../../src/config/codex-settings.js";
import {
  executeForegroundReviewRun,
  getForegroundReviewReadOnlyScopeRoot,
  isForegroundReviewReadOnlyActive,
  launchBackgroundReviewJob,
  runDetachedReviewJob,
  internalReviewJobCommandName,
} from "../../src/background/review-job.js";
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
import { isTerminalJobStatus } from "../../src/runtime/job-types.js";
import { applyStoredTaskPatch } from "../../src/runtime/patch-apply.js";
import {
  backgroundJobReportVariant,
  renderBackgroundJobLaunchMarkdown,
  renderBackgroundJobMarkdown,
  renderBackgroundJobsOverviewMarkdown,
} from "../../src/runtime/job-render.js";
import { REPORT_TYPE, sendReport, type ReportDetails } from "../../src/runtime/report-message.js";
import { parseTaskCommandOptions } from "../../src/runtime/task-command-options.js";
import {
  BACKGROUND_READONLY_ENV,
  ensureHeadlessReadOnlyBashWhitelisted,
  findReadOnlyScopeViolation,
  findReadOnlyScopeViolationInBashCommand,
  findProtectedPathInBashCommand,
  findProtectedPathMatch,
  isLikelyReadOnlyShellCommand,
} from "../../src/runtime/path-protection.js";
import { buildInspectionRetryGuidance, buildResearchPrompt, buildTaskPrompt, inspectResearchTools } from "../../src/runtime/session-prompts.js";
import { type ReviewCommandOptions } from "../../src/review/review-runner.js";
import { findStoredReview, listStoredReviews, storedReviewSortKey } from "../../src/runtime/review-store.js";
import { CODEX_THINKING_LEVELS, getCurrentSessionThinkingLevel, parseCodexThinkingLevel, type CodexThinkingLevel } from "../../src/runtime/thinking.js";
import {
  activateQueuedNativeResearchPromptsFromPayload,
  activateQueuedNativeResearchPrompt,
  appendNativeWebSearchTool,
  clearActiveNativeResearchPrompt,
  dropQueuedNativeResearchPrompt,
  queueNativeResearchPrompt,
  shouldAppendNativeWebSearchTool,
  supportsNativeWebSearch,
} from "../../src/runtime/native-tools.js";
import { reviewKindTitle, type CodexReviewKind } from "../../src/review/review-kind.js";
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
type PendingThinkingRestore = {
  previousLevel: CodexThinkingLevel;
  effectiveLevel: CodexThinkingLevel;
  assignedTurnIndex?: number;
  timeoutId?: ReturnType<typeof setTimeout>;
};
type PendingThinkingRestoreState = { current: PendingThinkingRestore | null };
type AgentLifecycleState = { running: boolean };
const INLINE_THINKING_RESTORE_TIMEOUT_MS = 15 * 60 * 1000;

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
  const { optionTokens, remainderTokens } = splitLeadingOptionTokens(tokens, ["--scope", "--base", "--model", "--thinking"]);
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
    if (token === "--thinking") {
      options.thinkingLevel = parseCodexThinkingLevel(optionTokens[index + 1]);
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

function parseResearchCommandOptions(
  rawArgs: string,
): { background: boolean; modelSpec?: string; thinkingLevel?: CodexThinkingLevel; request: string } {
  const tokens = splitShellLikeArgs(rawArgs);
  const { optionTokens, remainderTokens } = splitLeadingOptionTokens(tokens, ["--model", "--thinking"]);
  const request: string[] = [...remainderTokens];
  let background = false;
  let modelSpec: string | undefined;
  let thinkingLevel: CodexThinkingLevel | undefined;

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
    if (token === "--thinking") {
      thinkingLevel = parseCodexThinkingLevel(optionTokens[index + 1]);
      index += 1;
      continue;
    }
    request.push(...optionTokens.slice(index));
    break;
  }

  return {
    background,
    modelSpec,
    thinkingLevel,
    request: request.join(" ").trim(),
  };
}

function prepareInlineThinkingOverride(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  requestedLevel: CodexThinkingLevel | undefined,
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
  commandName: "task" | "research",
): { effectiveLevel?: CodexThinkingLevel; restoreQueued: boolean } {
  if (!requestedLevel) {
    return { effectiveLevel: undefined, restoreQueued: false };
  }
  if (pendingThinkingRestore.current) {
    throw new Error(
      `Another inline \`/codex:${commandName} --thinking ...\` turn is still pending. Wait for it to finish or use \`--background\`.`,
    );
  }
  if (!ctx.isIdle()) {
    throw new Error(
      `Inline \`/codex:${commandName} --thinking ...\` only works when the agent is idle. Wait for the current turn to finish or use \`--background\`.`,
    );
  }

  const previousLevel = getCurrentSessionThinkingLevel(pi, ctx) ?? pi.getThinkingLevel();
  pi.setThinkingLevel(requestedLevel);
  const effectiveLevel = pi.getThinkingLevel();

  if (effectiveLevel !== previousLevel) {
    const restore: PendingThinkingRestore = { previousLevel, effectiveLevel };
    const timeoutId = setTimeout(() => {
      if (pendingThinkingRestore.current !== restore) {
        return;
      }
      if (agentLifecycle.running && restore.assignedTurnIndex != null) {
        return;
      }
      pendingThinkingRestore.current = null;
      if (pi.getThinkingLevel() === restore.effectiveLevel) {
        pi.setThinkingLevel(previousLevel);
      }
    }, INLINE_THINKING_RESTORE_TIMEOUT_MS);
    timeoutId.unref?.();
    restore.timeoutId = timeoutId;
    pendingThinkingRestore.current = restore;
    return { effectiveLevel, restoreQueued: true };
  }

  return { effectiveLevel, restoreQueued: false };
}

function takePendingThinkingRestore(
  pendingThinkingRestore: PendingThinkingRestoreState,
  previousLevel?: CodexThinkingLevel,
): PendingThinkingRestore | null {
  if (!pendingThinkingRestore.current) {
    return null;
  }
  if (previousLevel && pendingThinkingRestore.current.previousLevel !== previousLevel) {
    return null;
  }
  const restore = pendingThinkingRestore.current;
  if (restore.timeoutId) {
    clearTimeout(restore.timeoutId);
  }
  pendingThinkingRestore.current = null;
  return restore;
}

function restorePendingThinkingLevel(
  pi: ExtensionAPI,
  pendingThinkingRestore: PendingThinkingRestoreState,
  previousLevel?: CodexThinkingLevel,
): boolean {
  const restore = takePendingThinkingRestore(pendingThinkingRestore, previousLevel);
  if (!restore) {
    return false;
  }
  if (pi.getThinkingLevel() === restore.effectiveLevel) {
    pi.setThinkingLevel(restore.previousLevel);
  }
  return true;
}

async function handleReviewCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  kind: CodexReviewKind,
  rawArgs: string,
): Promise<void> {
  const settings = loadCodexSettings(ctx.cwd);
  const options = parseReviewCommandOptions(rawArgs);
  if (!options.thinkingLevel) {
    options.thinkingLevel = getCurrentSessionThinkingLevel(pi, ctx);
  }
  if (kind === "review" && options.focusText) {
    throw new Error(
      `\`/codex:review\` is intentionally unsteered. If you want to point Codex at a specific concern, use \`/codex:adversarial-review ${options.focusText}\`.`,
    );
  }
  if (options.background) {
    const job = await launchBackgroundReviewJob(pi, ctx, settings, kind, options);
    sendReport(
      pi,
      `${reviewKindTitle(kind)} Job`,
      renderBackgroundJobLaunchMarkdown(job),
      "info",
    );
    return;
  }
  const run = await executeForegroundReviewRun(pi, ctx, settings, kind, options);
  sendReport(
    pi,
    reviewKindTitle(kind),
    renderStoredReviewMarkdown(run),
    run.result?.verdict === "needs-attention" || !run.result ? "warning" : "success",
  );
}

async function handleTaskCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
): Promise<boolean> {
  const settings = loadCodexSettings(ctx.cwd);
  if (!settings.enableTaskCommand) {
    sendReport(pi, "Codex Task", "# Codex Task\n\nThis workspace has the task command turned off in its current Codex settings.\n", "warning");
    return false;
  }

  const options = parseTaskCommandOptions(rawArgs);
  const request = options.request;
  if (!request) {
    sendReport(pi, "Codex Task", "# Codex Task\n\nAdd a task after the command, for example `/codex:task investigate why auth refresh fails`.\n", "warning");
    return false;
  }

  if (options.background) {
    const job = options.profile === "readonly"
      ? await launchBackgroundReadonlyTaskJob(pi, ctx, settings, request, options.modelSpec, options.thinkingLevel)
      : await launchBackgroundWriteTaskJob(pi, ctx, settings, request, options.modelSpec, options.thinkingLevel);
    sendReport(
      pi,
      "Codex Task Job",
      renderBackgroundJobLaunchMarkdown(job),
      "info",
    );
    return false;
  }

  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  const previousThinkingLevel = getCurrentSessionThinkingLevel(pi, ctx) ?? pi.getThinkingLevel();
  const inlineThinking = prepareInlineThinkingOverride(pi, ctx, options.thinkingLevel, pendingThinkingRestore, agentLifecycle, "task");
  try {
    pi.sendUserMessage(
      buildTaskPrompt(request, pi.getActiveTools(), {
        readOnly: options.profile === "readonly",
        activeWebTools: inspectResearchTools(pi).activeWebTools,
      }),
      deliverAs ? { deliverAs } : undefined,
    );
  } catch (error) {
    if (inlineThinking.restoreQueued) {
      restorePendingThinkingLevel(pi, pendingThinkingRestore, previousThinkingLevel);
    }
    throw error;
  }
  sendReport(
    pi,
    "Codex Task",
    renderTaskQueuedMarkdown(request, deliverAs === "followUp", {
      readOnly: options.profile === "readonly",
      ignoredModelSpec: options.modelSpec,
      appliedThinkingLevel: options.thinkingLevel ? inlineThinking.effectiveLevel : undefined,
    }),
    "info",
  );
  return true;
}

async function handleResearchCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rawArgs: string,
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
): Promise<boolean> {
  const settings = loadCodexSettings(ctx.cwd);
  if (!settings.enableResearchCommand) {
    sendReport(pi, "Codex Research", "# Codex Research\n\nThis workspace has the research command turned off in its current Codex settings.\n", "warning");
    return false;
  }

  const options = parseResearchCommandOptions(rawArgs);
  const request = options.request;
  if (!request) {
    sendReport(
      pi,
      "Codex Research",
      "# Codex Research\n\nAdd a research question after the command, for example `/codex:research compare PI extension APIs with Codex CLI and verify current web tooling support`.\n",
      "warning",
    );
    return false;
  }

  if (options.background) {
    const job = await launchBackgroundResearchJob(pi, ctx, settings, request, options.modelSpec, options.thinkingLevel);
    sendReport(pi, "Codex Research Job", renderBackgroundJobLaunchMarkdown(job), "info");
    return false;
  }

  const nativeWebSearchAvailable = supportsNativeWebSearch(ctx.model);
  const snapshot = inspectResearchTools(pi, { nativeWebSearchAvailable });
  snapshot.nativeWebSearchAvailable = nativeWebSearchAvailable;
  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  const previousThinkingLevel = getCurrentSessionThinkingLevel(pi, ctx) ?? pi.getThinkingLevel();
  const inlineThinking = prepareInlineThinkingOverride(pi, ctx, options.thinkingLevel, pendingThinkingRestore, agentLifecycle, "research");
  const prompt = buildResearchPrompt(request, snapshot);
  try {
    if (snapshot.nativeWebSearchAvailable) {
      queueNativeResearchPrompt(prompt);
    }
    pi.sendUserMessage(prompt, deliverAs ? { deliverAs } : undefined);
  } catch (error) {
    if (snapshot.nativeWebSearchAvailable) {
      dropQueuedNativeResearchPrompt(prompt);
    }
    if (inlineThinking.restoreQueued) {
      restorePendingThinkingLevel(pi, pendingThinkingRestore, previousThinkingLevel);
    }
    throw error;
  }
  sendReport(
    pi,
    "Codex Research",
    renderResearchQueuedMarkdown(request, deliverAs === "followUp", snapshot, options.thinkingLevel ? inlineThinking.effectiveLevel : undefined),
    "info",
  );
  return true;
}

async function runTaskCommandWithWaiter(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  pendingInjectedTurnWaiters: InjectedTurnWaiter[],
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
): Promise<void> {
  const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
  if (waiter) {
    pendingInjectedTurnWaiters.push(waiter);
  }

  try {
    const injected = await handleTaskCommand(pi, ctx, args, pendingThinkingRestore, agentLifecycle);
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
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
): Promise<void> {
  const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
  if (waiter) {
    pendingInjectedTurnWaiters.push(waiter);
  }

  try {
    const injected = await handleResearchCommand(pi, ctx, args, pendingThinkingRestore, agentLifecycle);
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
  pendingThinkingRestore: PendingThinkingRestoreState,
  agentLifecycle: AgentLifecycleState,
): Promise<boolean> {
  switch (name) {
    case "codex:review":
      await handleReviewCommand(pi, ctx, "review", args);
      return true;
    case "codex:adversarial-review":
      await handleReviewCommand(pi, ctx, "adversarial-review", args);
      return true;
    case "codex:adversarial_mental_models_review":
      await handleReviewCommand(pi, ctx, "adversarial-mental-models-review", args);
      return true;
    case "codex:task":
      await runTaskCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters, pendingThinkingRestore, agentLifecycle);
      return true;
    case "codex:research":
      await runResearchCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters, pendingThinkingRestore, agentLifecycle);
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
      sendReport(pi, "Codex Status", `# Codex Status\n\nNo background job or saved review matches \`${reference}\` in this workspace.\n`, "warning");
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
  if (isExplicitLatestResultRequest(rawArgs)) {
    const latest = resolveLatestStoredResult(ctx.cwd);
    if (!latest) {
      sendReport(pi, "Codex Result", "# Codex Result\n\nThere is no saved result in this workspace yet.\n", "warning");
      return;
    }

    if (latest.kind === "job") {
      const markdown = readBackgroundJobResultMarkdown(latest.job.workspaceRoot, latest.job.id);
      if (markdown) {
        sendReport(pi, "Codex Result", markdown, backgroundJobReportVariant(latest.job));
        return;
      }

      sendReport(pi, "Codex Result", renderBackgroundJobMarkdown(latest.job), backgroundJobReportVariant(latest.job));
      return;
    }

    sendReport(pi, "Codex Result", renderStoredReviewMarkdown(latest.run), "info");
    return;
  }

  const reference = normalizeLatestResultReference(rawArgs);
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
    sendReport(pi, "Codex Result", "# Codex Result\n\nThere is no saved result matching that request in this workspace.\n", "warning");
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
    sendReport(pi, "Codex Cancel", "# Codex Cancel\n\nThere is no active background Codex job to cancel in this workspace.\n", "warning");
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
    sendReport(pi, "Codex Apply", "# Codex Apply\n\nProvide a completed background write-task id, for example `/codex:apply task-m123abc`.\n", "warning");
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
    sendReport(pi, "Codex Apply", "# Codex Apply\n\nOnly completed background write tasks can be applied back to the live repository.\n", "warning");
    return;
  }

  try {
    const applied = applyStoredTaskPatch(ctx.cwd, job);
    const lines = [
      "# Codex Apply",
      "",
      "Applied the saved background write-task patch to the live repository.",
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
  sendReport(pi, "Codex Config", renderConfigMarkdown(settings, currentModel, getCurrentSessionThinkingLevel(pi, ctx) ?? pi.getThinkingLevel()), "info");
}

type ArgumentCompletionProvider = (argumentPrefix: string) => AutocompleteItem[] | null;

type FlagCompletionSpec = {
  flag: string;
  description: string;
  values?: Array<{ value: string; description: string }>;
};

function thinkingFlagCompletionSpec(description: string): FlagCompletionSpec {
  return {
    flag: "--thinking",
    description,
    values: CODEX_THINKING_LEVELS.map((value) => ({
      value,
      description:
        value === "off"
          ? "Use the model without extra reasoning."
          : `Use ${value} reasoning effort for this run.`,
    })),
  };
}

function buildFlagArgumentCompletions(argumentPrefix: string, specs: FlagCompletionSpec[]): AutocompleteItem[] | null {
  const prefix = argumentPrefix;
  const trimmedEnd = prefix.replace(/\s+$/, "");
  const hasTrailingSpace = trimmedEnd.length !== prefix.length;
  const parsedTokens = trimmedEnd.length > 0 ? splitShellLikeArgs(trimmedEnd) : [];
  const committedTokens = hasTrailingSpace ? [...parsedTokens] : parsedTokens.slice(0, -1);
  const activeToken = hasTrailingSpace ? "" : (parsedTokens.at(-1) ?? "");
  const previousToken = committedTokens.at(-1) ?? "";
  const basePrefix = committedTokens.length > 0 ? `${committedTokens.join(" ")} ` : "";
  const flagsWithValues = new Set(specs.filter((spec) => spec.values && spec.values.length > 0).map((spec) => spec.flag));

  let committedIndex = 0;
  while (committedIndex < committedTokens.length) {
    const token = committedTokens[committedIndex];
    if (token === "--") {
      return null;
    }
    if (!token.startsWith("--")) {
      return null;
    }

    committedIndex += 1;
    if (flagsWithValues.has(token)) {
      const next = committedTokens[committedIndex];
      if (next && next !== "--" && !next.startsWith("--")) {
        committedIndex += 1;
      }
    }
  }

  if (activeToken && !activeToken.startsWith("--") && !(flagsWithValues.has(previousToken) && !hasTrailingSpace)) {
    return null;
  }

  const usedFlags = new Set(committedTokens.filter((token) => token.startsWith("--")));

  const valueSpec = specs.find((spec) => spec.flag === previousToken && spec.values && spec.values.length > 0);
  if (valueSpec?.values) {
    const items = valueSpec.values
      .filter((item) => item.value.startsWith(activeToken))
      .map((item) => ({
        value: `${basePrefix}${item.value} `,
        label: item.value,
        description: item.description,
      }));
    return items.length > 0 ? items : null;
  }

  const items = specs
    .filter((spec) => activeToken === "" || spec.flag.startsWith(activeToken))
    .filter((spec) => !usedFlags.has(spec.flag))
    .flatMap((spec) => {
      if (!spec.values || spec.values.length === 0) {
        return [
          {
            value: `${basePrefix}${spec.flag} `,
            label: spec.flag,
            description: spec.description,
          },
        ];
      }

      return spec.values.map((item) => ({
        value: `${basePrefix}${spec.flag} ${item.value} `,
        label: `${spec.flag} ${item.value}`,
        description: item.description,
      }));
    });

  return items.length > 0 ? items : null;
}

function reviewArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return buildFlagArgumentCompletions(argumentPrefix, [
    {
      flag: "--background",
      description: "Run this review in the background and notify you when it finishes.",
    },
    {
      flag: "--scope",
      description: "Choose what Codex should review.",
      values: [
        { value: "working-tree", description: "Review staged, unstaged, and untracked changes in your current checkout." },
        { value: "branch", description: "Review the full branch diff against a base ref." },
      ],
    },
    {
      flag: "--base",
      description: "Choose the base ref for `--scope branch`.",
      values: [
        { value: "origin/main", description: "Compare the current branch against origin/main." },
        { value: "main", description: "Compare the current branch against local main." },
        { value: "origin/develop", description: "Compare the current branch against origin/develop." },
        { value: "develop", description: "Compare the current branch against local develop." },
      ],
    },
    {
      flag: "--model",
      description: "Use a different model for this review.",
      values: [{ value: "openai-codex/gpt-5.3-codex", description: "Use a Codex model for this run." }],
    },
    thinkingFlagCompletionSpec("Set the reasoning effort for this review."),
  ]);
}

function taskArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return buildFlagArgumentCompletions(argumentPrefix, [
    {
      flag: "--readonly",
      description: "Inspect and explain only. Do not edit files.",
    },
    {
      flag: "--write",
      description: "Allow Codex to make code changes for this task.",
    },
    {
      flag: "--background",
      description: "Run this task in the background and notify you when it finishes.",
    },
    {
      flag: "--model",
      description: "Use a different model for this task.",
      values: [{ value: "openai-codex/gpt-5.3-codex", description: "Use a Codex model for this run." }],
    },
    thinkingFlagCompletionSpec("Set the reasoning effort for this task."),
  ]);
}

function researchArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return buildFlagArgumentCompletions(argumentPrefix, [
    {
      flag: "--background",
      description: "Run this research in the background and notify you when it finishes.",
    },
    {
      flag: "--model",
      description: "Use a different model for this research run.",
      values: [{ value: "openai-codex/gpt-5.3-codex", description: "Use a Codex model for this run." }],
    },
    thinkingFlagCompletionSpec("Set the reasoning effort for this research run."),
  ]);
}

function resultArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return buildFlagArgumentCompletions(argumentPrefix, [
    {
      flag: "--last",
      description: "Open the latest saved result for this workspace.",
    },
  ]);
}

function normalizeLatestResultReference(rawArgs: string): string | undefined {
  const trimmed = rawArgs.trim();
  if (!trimmed || trimmed === "--last") {
    return undefined;
  }
  return trimmed;
}

function isExplicitLatestResultRequest(rawArgs: string): boolean {
  return rawArgs.trim() === "--last";
}

function backgroundResultSortKey(job: ReturnType<typeof listBackgroundJobs>[number]): string {
  return job.completedAt ?? job.cancelledAt ?? job.updatedAt ?? job.createdAt;
}

function resolveLatestStoredResult(
  cwd: string,
): { kind: "job"; job: ReturnType<typeof listBackgroundJobs>[number] } | { kind: "review"; run: ReturnType<typeof listStoredReviews>[number] } | null {
  const terminalJobs = listBackgroundJobs(cwd)
    .filter((job) => isTerminalJobStatus(job.status))
    .sort((left, right) => backgroundResultSortKey(right).localeCompare(backgroundResultSortKey(left)));
  const latestReview = listStoredReviews(cwd)[0] ?? null;
  const latestTerminalJob = terminalJobs[0] ?? null;

  if (latestTerminalJob && latestReview) {
    return backgroundResultSortKey(latestTerminalJob).localeCompare(storedReviewSortKey(latestReview)) >= 0
      ? { kind: "job", job: latestTerminalJob }
      : { kind: "review", run: latestReview };
  }
  if (latestTerminalJob) {
    return { kind: "job", job: latestTerminalJob };
  }
  if (latestReview) {
    return { kind: "review", run: latestReview };
  }

  return null;
}

function registerCommandPair(
  pi: ExtensionAPI,
  name: string,
  alias: string,
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  getArgumentCompletions?: ArgumentCompletionProvider,
): void {
  for (const commandName of [name, alias]) {
    pi.registerCommand(commandName, {
      description,
      ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
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
  getArgumentCompletions?: ArgumentCompletionProvider,
): void {
  pi.registerCommand(name, {
    description,
    ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
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
  const pendingThinkingRestore: PendingThinkingRestoreState = { current: null };
  const agentLifecycle: AgentLifecycleState = { running: false };

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
        pendingThinkingRestore,
        agentLifecycle,
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

  pi.on("before_agent_start", async (event) => {
    activateQueuedNativeResearchPrompt(event.prompt);
  });

  pi.on("before_provider_request", async (event) => {
    if (!shouldAppendNativeWebSearchTool(event.payload)) {
      return undefined;
    }
    activateQueuedNativeResearchPromptsFromPayload(event.payload);
    return appendNativeWebSearchTool(event.payload);
  });

  pi.on("agent_start", async () => {
    agentLifecycle.running = true;
  });

  pi.on("turn_start", async (event) => {
    if (pendingThinkingRestore.current && pendingThinkingRestore.current.assignedTurnIndex == null && event?.turnIndex != null) {
      pendingThinkingRestore.current.assignedTurnIndex = event.turnIndex;
    }
  });

  pi.on("turn_end", async (event) => {
    const waiter = pendingInjectedTurnWaiters.shift();
    waiter?.resolve();
    const restore = pendingThinkingRestore.current;
    if (!restore) {
      return;
    }
    if (restore.assignedTurnIndex != null && event?.turnIndex != null && restore.assignedTurnIndex !== event.turnIndex) {
      return;
    }
    restorePendingThinkingLevel(pi, pendingThinkingRestore);
  });

  pi.on("agent_end", async () => {
    agentLifecycle.running = false;
    clearActiveNativeResearchPrompt();
    restorePendingThinkingLevel(pi, pendingThinkingRestore);
  });

  pi.on("session_shutdown", async () => {
    agentLifecycle.running = false;
    clearActiveNativeResearchPrompt();
    restorePendingThinkingLevel(pi, pendingThinkingRestore);
  });

  pi.on("tool_call", async (event, ctx) => {
    const settings = loadCodexSettings(ctx.cwd);
    let blockedTarget: string | null = null;
    let builtinAlternativeReason: string | null = null;
    const readOnlyWorkerMode = process.env[BACKGROUND_READONLY_ENV] === "1" || isForegroundReviewReadOnlyActive();
    const readOnlyScopeRoot = process.env[BACKGROUND_READONLY_ENV] === "1"
      ? ctx.cwd
      : (getForegroundReviewReadOnlyScopeRoot() ?? ctx.cwd);

    if (event.toolName === "edit" || event.toolName === "write") {
      if (readOnlyWorkerMode) {
        return { block: true, reason: "Codex readonly workers are read-only. Do not edit or write files in this worker." };
      }
      const pathValue = String((event.input as { path?: unknown }).path ?? "");
      blockedTarget = findProtectedPathMatch(pathValue, settings.protectedPaths);
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      const readOnlyBashAllowed = readOnlyWorkerMode && isLikelyReadOnlyShellCommand(command);
      if (readOnlyWorkerMode && !readOnlyBashAllowed) {
        return {
          block: true,
          reason: "Codex readonly workers are read-only. Use bash only for non-mutating inspection such as git diff/show/log/status or other read-only commands.",
        };
      }
      if (readOnlyWorkerMode) {
        const scopeViolation = findReadOnlyScopeViolationInBashCommand(command, readOnlyScopeRoot, ctx.cwd);
        if (scopeViolation) {
          return {
            block: true,
            reason: `Codex readonly workers can only inspect paths inside the current repository. "${scopeViolation}" is outside that boundary.`,
          };
        }
      }
      if (readOnlyBashAllowed && !ctx.hasUI && !ensureHeadlessReadOnlyBashWhitelisted(ctx.cwd, command)) {
        return {
          block: true,
          reason: "Codex could not pre-authorize this safe readonly bash command for headless execution. Use built-in read/find/grep/ls inspection instead.",
        };
      }
      const builtinAlternative = detectBuiltinAlternativeForBash(command, pi.getActiveTools());
      if (builtinAlternative) {
        builtinAlternativeReason = builtinAlternative.reason;
      }
      blockedTarget = findProtectedPathInBashCommand(command, settings.protectedPaths);
    }

    if (readOnlyWorkerMode && ["read", "grep", "find", "ls"].includes(event.toolName)) {
      const scopeViolation = findReadOnlyScopeViolation(event.toolName, event.input, readOnlyScopeRoot, ctx.cwd);
      if (scopeViolation) {
        return {
          block: true,
          reason: `Codex readonly workers can only inspect paths inside the current repository. "${scopeViolation}" is outside that boundary.`,
        };
      }
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
      if (textBody.includes("Codex readonly workers are read-only.")) {
        return {
          content: [
            {
              type: "text",
              text: [
                textBody,
                "",
                "Stay read-only in this background worker.",
                "Use repository inspection tools or non-mutating git/bash commands instead of retrying a write or mutation.",
              ].join("\n"),
            },
          ],
        };
      }

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

  registerSingleCommand(
    pi,
    "codex:review",
    "Review the current repo changes [--background] [--scope working-tree|branch] [--base <ref>] [--model <provider/model>] [--thinking <level>]",
    async (args, ctx) => {
      await handleReviewCommand(pi, ctx, "review", args);
    },
    reviewArgumentCompletions,
  );
  registerSingleCommand(
    pi,
    "codex:adversarial-review",
    "Run a stricter, risk-focused review [--background] [--scope working-tree|branch] [--base <ref>] [--model <provider/model>] [--thinking <level>]",
    async (args, ctx) => {
      await handleReviewCommand(pi, ctx, "adversarial-review", args);
    },
    reviewArgumentCompletions,
  );
  registerSingleCommand(
    pi,
    "codex:adversarial_mental_models_review",
    "Run the deepest multi-lens review [--background] [--scope working-tree|branch] [--base <ref>] [--model <provider/model>] [--thinking <level>]",
    async (args, ctx) => {
      await handleReviewCommand(pi, ctx, "adversarial-mental-models-review", args);
    },
    reviewArgumentCompletions,
  );
  registerSingleCommand(
    pi,
    "codex:task",
    "Ask Codex to inspect or implement work [--readonly|--write] [--background] [--model <provider/model>] [--thinking <level>]",
    async (args, ctx) => {
      await runTaskCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters, pendingThinkingRestore, agentLifecycle);
    },
    taskArgumentCompletions,
  );
  registerSingleCommand(
    pi,
    "codex:research",
    "Ask Codex to research a question [--background] [--model <provider/model>] [--thinking <level>]",
    async (args, ctx) => {
      await runResearchCommandWithWaiter(pi, ctx, args, pendingInjectedTurnWaiters, pendingThinkingRestore, agentLifecycle);
    },
    researchArgumentCompletions,
  );
  pi.registerCommand(internalReviewJobCommandName(), {
    description: "Internal pi-codex background review runner",
    handler: async (args, ctx) => {
      const jobId = args.trim();
      if (!jobId) {
        throw new Error("Background review runner requires a job id.");
      }
      await runDetachedReviewJob(pi, ctx, loadCodexSettings(ctx.cwd), jobId);
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
  registerCommandPair(pi, "codex:status", "codex-status", "Show job progress or recent review history for this workspace", async (args, ctx) => {
    await handleStatusCommand(pi, ctx, args);
  });
  registerCommandPair(
    pi,
    "codex:result",
    "codex-result",
    "Open a saved result [--last|<job-id>] for this workspace",
    async (args, ctx) => {
      await handleResultCommand(pi, ctx, args);
    },
    resultArgumentCompletions,
  );
  registerCommandPair(pi, "codex:cancel", "codex-cancel", "Cancel an active background Codex job in this workspace", async (args, ctx) => {
    await handleCancelCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:jobs", "codex-jobs", "List recent background Codex jobs in this workspace", async (_args, ctx) => {
    await handleJobsCommand(pi, ctx);
  });
  registerCommandPair(pi, "codex:apply", "codex-apply", "Apply a saved background write-task patch to the live repository", async (args, ctx) => {
    await handleApplyCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:config", "codex-config", "Show the active pi-codex settings for this PI session", async (_args, ctx) => {
    await handleConfigCommand(pi, ctx);
  });
}
