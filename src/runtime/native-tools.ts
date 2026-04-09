import type { Model } from "@mariozechner/pi-ai";

const NATIVE_WEB_SEARCH_PROVIDERS = new Set(["openai", "openai-codex"]);
const NATIVE_WEB_SEARCH_APIS = new Set(["openai-responses", "openai-codex-responses"]);

const activeNativeResearchPrompts = new Set<string>();
const queuedNativeResearchPrompts: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsNativeWebSearch(model: Pick<Model<any>, "provider" | "api"> | null | undefined): boolean {
  return Boolean(model && NATIVE_WEB_SEARCH_PROVIDERS.has(model.provider) && NATIVE_WEB_SEARCH_APIS.has(model.api));
}

export function appendNativeWebSearchTool(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const hasNativeWebSearch = existingTools.some((tool) => isRecord(tool) && tool.type === "web_search");
  if (hasNativeWebSearch) {
    return payload;
  }

  return {
    ...payload,
    tools: [...existingTools, { type: "web_search" }],
  };
}

function normalizePrompt(prompt: string): string {
  return prompt.trim();
}

function latestUserInputTexts(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    return [];
  }

  const userItems = payload.input.filter((entry: unknown): entry is Record<string, unknown> => (
    isRecord(entry) && entry.role === "user" && Array.isArray(entry.content)
  ));
  const latestUser = userItems.at(-1);
  if (!latestUser || !Array.isArray(latestUser.content)) {
    return [];
  }

  return latestUser.content
    .filter((entry): entry is Record<string, unknown> => (
      isRecord(entry)
      && entry.type === "input_text"
      && typeof entry.text === "string"
      && entry.text.trim().length > 0
    ))
    .map((entry) => normalizePrompt(String(entry.text)));
}

export function shouldAppendNativeWebSearchTool(payload: unknown): boolean {
  const latestTexts = latestUserInputTexts(payload);
  if (latestTexts.length === 0) {
    return false;
  }

  return latestTexts.some((text) => (
    activeNativeResearchPrompts.has(text) || queuedNativeResearchPrompts.includes(text)
  ));
}

export function activateQueuedNativeResearchPromptsFromPayload(payload: unknown): boolean {
  const latestTexts = latestUserInputTexts(payload);
  if (latestTexts.length === 0) {
    return false;
  }

  let activated = false;
  for (const text of latestTexts) {
    activated = activateQueuedNativeResearchPrompt(text) || activated;
  }
  return activated;
}

export function queueNativeResearchPrompt(prompt: string): void {
  const normalized = normalizePrompt(prompt);
  if (!normalized || queuedNativeResearchPrompts.includes(normalized) || activeNativeResearchPrompts.has(normalized)) {
    return;
  }
  queuedNativeResearchPrompts.push(normalized);
}

export function activateQueuedNativeResearchPrompt(prompt: string): boolean {
  const normalized = normalizePrompt(prompt);
  const index = queuedNativeResearchPrompts.indexOf(normalized);
  if (index < 0) {
    return false;
  }

  queuedNativeResearchPrompts.splice(index, 1);
  activeNativeResearchPrompts.add(normalized);
  return true;
}

export function dropQueuedNativeResearchPrompt(prompt: string): void {
  const normalized = normalizePrompt(prompt);
  const index = queuedNativeResearchPrompts.indexOf(normalized);
  if (index >= 0) {
    queuedNativeResearchPrompts.splice(index, 1);
  }
  activeNativeResearchPrompts.delete(normalized);
}

export function clearActiveNativeResearchPrompt(prompt?: string): void {
  if (activeNativeResearchPrompts.size === 0) {
    return;
  }
  if (prompt) {
    activeNativeResearchPrompts.delete(normalizePrompt(prompt));
  } else {
    activeNativeResearchPrompts.clear();
  }
}
