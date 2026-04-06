import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { supportsXhigh, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";

export const CODEX_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type CodexThinkingLevel = (typeof CODEX_THINKING_LEVELS)[number];

export function isCodexThinkingLevel(value: unknown): value is CodexThinkingLevel {
  return typeof value === "string" && (CODEX_THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseCodexThinkingLevel(value: string | undefined, flagName = "--thinking"): CodexThinkingLevel {
  if (!value || !isCodexThinkingLevel(value)) {
    throw new Error(`\`${flagName}\` must be one of: ${CODEX_THINKING_LEVELS.join(", ")}.`);
  }
  return value;
}

export function resolveEffectiveThinkingLevel(model: Model<any>, requestedLevel: CodexThinkingLevel | undefined): CodexThinkingLevel | undefined {
  if (!requestedLevel) {
    return undefined;
  }
  if (!model.reasoning) {
    return "off";
  }
  if (requestedLevel === "xhigh" && !supportsXhigh(model)) {
    return "high";
  }
  return requestedLevel;
}

export function reasoningLevelForCompletion(level: CodexThinkingLevel | undefined): SimpleStreamOptions["reasoning"] | undefined {
  if (!level || level === "off") {
    return undefined;
  }
  return level;
}

export function getCurrentSessionThinkingLevel(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx?: Pick<ExtensionCommandContext, "sessionManager"> | null,
): CodexThinkingLevel | undefined {
  const sessionManager = ctx?.sessionManager as { buildSessionContext?: () => { thinkingLevel?: unknown } } | undefined;
  const sessionThinking = sessionManager?.buildSessionContext?.().thinkingLevel;
  if (isCodexThinkingLevel(sessionThinking)) {
    return sessionThinking;
  }
  const apiThinking = pi.getThinkingLevel();
  return isCodexThinkingLevel(apiThinking) ? apiThinking : undefined;
}
