import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";

import { loadCodexSettings, registerCodexSettings } from "../../src/config/codex-settings.js";
import { splitShellLikeArgs } from "../../src/runtime/arg-parser.js";
import { findProtectedPathInBashCommand, findProtectedPathMatch } from "../../src/runtime/path-protection.js";
import { buildResearchPrompt, buildTaskPrompt, inspectResearchTools } from "../../src/runtime/session-prompts.js";
import { executeReviewRun, type ReviewCommandOptions } from "../../src/review/review-runner.js";
import { findStoredReview, listStoredReviews } from "../../src/runtime/review-store.js";
import {
  renderConfigMarkdown,
  renderResearchQueuedMarkdown,
  renderReviewStatusMarkdown,
  renderStoredReviewMarkdown,
  renderTaskQueuedMarkdown,
} from "../../src/review/review-render.js";

type ReportDetails = {
  title: string;
  variant?: "info" | "success" | "warning" | "error";
  timestamp: number;
};

const REPORT_TYPE = "codex-report";
const IS_PRINT_MODE = process.argv.includes("-p") || process.argv.includes("--print");

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

function sendReport(pi: ExtensionAPI, title: string, markdown: string, variant: ReportDetails["variant"] = "info"): void {
  pi.sendMessage({
    customType: REPORT_TYPE,
    content: markdown,
    display: true,
    details: {
      title,
      variant,
      timestamp: Date.now(),
    } satisfies ReportDetails,
  });
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

function parseReviewCommandOptions(rawArgs: string): ReviewCommandOptions {
  const tokens = splitShellLikeArgs(rawArgs);
  const options: ReviewCommandOptions = {};
  const focus: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--scope") {
      const next = tokens[index + 1];
      if (!next || (next !== "auto" && next !== "working-tree" && next !== "branch")) {
        throw new Error("`--scope` must be one of: auto, working-tree, branch.");
      }
      options.scope = next;
      index += 1;
      continue;
    }
    if (token === "--base") {
      const next = tokens[index + 1];
      if (!next) {
        throw new Error("`--base` requires a git ref.");
      }
      options.base = next;
      index += 1;
      continue;
    }
    if (token === "--model") {
      const next = tokens[index + 1];
      if (!next) {
        throw new Error("`--model` requires provider/modelId.");
      }
      options.modelSpec = next;
      index += 1;
      continue;
    }
    focus.push(token);
  }

  const focusText = focus.join(" ").trim();
  if (focusText) {
    options.focusText = focusText;
  }

  return options;
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

  const request = rawArgs.trim();
  if (!request) {
    sendReport(pi, "Codex Task", "# Codex Task\n\nProvide a request, for example `/codex:task investigate why auth refresh fails`.\n", "warning");
    return false;
  }

  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  pi.sendUserMessage(buildTaskPrompt(request), deliverAs ? { deliverAs } : undefined);
  sendReport(pi, "Codex Task", renderTaskQueuedMarkdown(request, deliverAs === "followUp"), "info");
  return true;
}

async function handleResearchCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<boolean> {
  const settings = loadCodexSettings(ctx.cwd);
  if (!settings.enableResearchCommand) {
    sendReport(pi, "Codex Research", "# Codex Research\n\nThe research command is disabled in the current Codex settings.\n", "warning");
    return false;
  }

  const request = rawArgs.trim();
  if (!request) {
    sendReport(
      pi,
      "Codex Research",
      "# Codex Research\n\nProvide a request, for example `/codex:research compare PI extension APIs with Codex CLI and verify current web tooling support`.\n",
      "warning",
    );
    return false;
  }

  const snapshot = inspectResearchTools(pi);
  const deliverAs = ctx.isIdle() ? undefined : "followUp";
  pi.sendUserMessage(buildResearchPrompt(request, snapshot), deliverAs ? { deliverAs } : undefined);
  sendReport(pi, "Codex Research", renderResearchQueuedMarkdown(request, deliverAs === "followUp", snapshot), "info");
  return true;
}

async function handleStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const reference = rawArgs.trim() || undefined;
  if (reference) {
    const run = findStoredReview(ctx.cwd, reference);
    if (!run) {
      sendReport(pi, "Codex Result", `# Codex Result\n\nNo stored review matches \`${reference}\` for this workspace.\n`, "warning");
      return;
    }
    sendReport(pi, "Codex Result", renderStoredReviewMarkdown(run), "info");
    return;
  }

  const runs = listStoredReviews(ctx.cwd).slice(0, loadCodexSettings(ctx.cwd).reviewHistoryLimit);
  sendReport(pi, "Codex Review Status", renderReviewStatusMarkdown(runs), "info");
}

async function handleResultCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const run = findStoredReview(ctx.cwd, rawArgs.trim() || undefined);
  if (!run) {
    sendReport(pi, "Codex Result", "# Codex Result\n\nNo stored review results are available for this workspace.\n", "warning");
    return;
  }
  sendReport(pi, "Codex Result", renderStoredReviewMarkdown(run), "info");
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

export default function registerCodexExtension(pi: ExtensionAPI): void {
  let pendingInjectedTurnWaiters: Array<{ resolve: () => void }> = [];

  registerCodexSettings(pi);

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

    if (event.toolName === "edit" || event.toolName === "write") {
      const pathValue = String((event.input as { path?: unknown }).path ?? "");
      blockedTarget = findProtectedPathMatch(pathValue, settings.protectedPaths);
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      blockedTarget = findProtectedPathInBashCommand(command, settings.protectedPaths);
    }

    if (!blockedTarget) {
      return undefined;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(`Blocked mutation of protected path: ${blockedTarget}`, "warning");
    }
    return { block: true, reason: `Path "${blockedTarget}" is protected by pi-codex.` };
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
      return undefined;
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

  registerCommandPair(pi, "codex:review", "codex-review", "Run a structured Codex review for the current repository state", async (args, ctx) => {
    await handleReviewCommand(pi, ctx, "review", args);
  });
  registerCommandPair(
    pi,
    "codex:adversarial-review",
    "codex-adversarial-review",
    "Run an adversarial Codex review for the current repository state",
    async (args, ctx) => {
      await handleReviewCommand(pi, ctx, "adversarial-review", args);
    },
  );
  registerCommandPair(pi, "codex:task", "codex-task", "Inject a Codex-style implementation request into the active PI session", async (args, ctx) => {
    const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
    if (waiter) {
      pendingInjectedTurnWaiters.push(waiter);
    }

    const injected = await handleTaskCommand(pi, ctx, args);
    if (waiter && !injected) {
      pendingInjectedTurnWaiters = pendingInjectedTurnWaiters.filter((entry) => entry !== waiter);
      waiter.resolve();
    }
    if (waiter && injected) {
      await waiter.promise;
    }
  });
  registerCommandPair(
    pi,
    "codex:research",
    "codex-research",
    "Inject a Codex-style research request into the active PI session, adapted to active PI web and evidence tools",
    async (args, ctx) => {
      const waiter = IS_PRINT_MODE ? createInjectedTurnWaiter() : null;
      if (waiter) {
        pendingInjectedTurnWaiters.push(waiter);
      }

      const injected = await handleResearchCommand(pi, ctx, args);
      if (waiter && !injected) {
        pendingInjectedTurnWaiters = pendingInjectedTurnWaiters.filter((entry) => entry !== waiter);
        waiter.resolve();
      }
      if (waiter && injected) {
        await waiter.promise;
      }
    },
  );
  registerCommandPair(pi, "codex:status", "codex-status", "Show stored Codex review history for the current workspace", async (args, ctx) => {
    await handleStatusCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:result", "codex-result", "Show a stored Codex review result for the current workspace", async (args, ctx) => {
    await handleResultCommand(pi, ctx, args);
  });
  registerCommandPair(pi, "codex:config", "codex-config", "Show the merged Codex configuration for this PI session", async (_args, ctx) => {
    await handleConfigCommand(pi, ctx);
  });
}
