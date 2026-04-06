import { complete, type Message, type Model } from "@mariozechner/pi-ai";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { CodexSettings, ReviewScope } from "../config/codex-settings.js";
import { collectReviewContext, resolveReviewTarget } from "./git-context.js";
import { parseStructuredReviewOutput, type StoredReviewRun } from "./review-schema.js";
import { generateReviewId, storeReviewRun } from "../runtime/review-store.js";
import {
  reasoningLevelForCompletion,
  resolveEffectiveThinkingLevel,
  type CodexThinkingLevel,
} from "../runtime/thinking.js";

export interface ReviewCommandOptions {
  scope?: ReviewScope;
  base?: string;
  modelSpec?: string;
  thinkingLevel?: CodexThinkingLevel;
  focusText?: string;
  background?: boolean;
}

export interface PreparedReviewExecutionInput {
  id?: string;
  kind: "review" | "adversarial-review";
  repoRoot: string;
  branch: string;
  targetLabel: string;
  targetMode: "working-tree" | "branch";
  targetBaseRef?: string;
  reviewInput: string;
  modelSpec?: string;
  thinkingLevel?: CodexThinkingLevel;
  focusText?: string;
}

const REVIEW_PROMPT = `<role>
You are Codex performing a software review.
Your job is to identify material bugs, regressions, and missing validation in the provided repository context.
</role>

<task>
Review the provided repository context.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<review_method>
Prioritize correctness, data safety, rollback safety, compatibility, race conditions, missing guards, and test gaps.
Prefer strong findings over a long weak list.
Avoid style feedback unless it hides a real risk.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why does the current code allow it?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<dig_deeper_nudge>
After you find the first plausible issue, check for missing guards, empty-state behavior, retries, stale state, rollback risk, compatibility edge cases, and test gaps before you finalize.
</dig_deeper_nudge>

<structured_output_contract>
Return only valid JSON matching this shape:
{
  "verdict": "approve" | "needs-attention",
  "summary": string,
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": string,
      "body": string,
      "file": string,
      "line_start": integer,
      "line_end": integer,
      "confidence": number,
      "recommendation": string
    }
  ],
  "next_steps": string[]
}

Use "needs-attention" if there is any material issue worth fixing before shipping.
Use "approve" only if you cannot support any substantive finding from the provided context.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Every finding must be defensible from the provided repository context.
If you infer behavior, say so explicitly in the finding body and keep confidence honest.
Do not invent files, line numbers, or runtime failures.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<final_check>
Before finalizing, check that each finding is:
- tied to a concrete code location
- plausible under a real failure scenario
- grounded in the provided context
- actionable for an engineer fixing the issue
</final_check>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`;

const ADVERSARIAL_REVIEW_PROMPT = `<role>
You are Codex performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, but still report any other material issue you can defend.
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching this shape:
{
  "verdict": "approve" | "needs-attention",
  "summary": string,
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": string,
      "body": string,
      "file": string,
      "line_start": integer,
      "line_end": integer,
      "confidence": number,
      "recommendation": string
    }
  ],
  "next_steps": string[]
}

Use "needs-attention" if there is any material blocking risk.
Use "approve" only if you cannot support any substantive adversarial finding from the provided context.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<final_check>
Before finalizing, check that each finding is:
- adversarial rather than stylistic
- tied to a concrete code location
- plausible under a real failure scenario
- actionable for an engineer fixing the issue
</final_check>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`;

function interpolatePrompt(
  template: string,
  values: Record<"TARGET_LABEL" | "USER_FOCUS" | "REVIEW_INPUT", string>,
): string {
  return template
    .replaceAll("{{TARGET_LABEL}}", values.TARGET_LABEL)
    .replaceAll("{{USER_FOCUS}}", values.USER_FOCUS)
    .replaceAll("{{REVIEW_INPUT}}", values.REVIEW_INPUT);
}

export function resolveModel(ctx: ExtensionCommandContext, settings: CodexSettings, explicitModel?: string): Model<any> {
  const modelSpec = explicitModel ?? settings.defaultReviewModel;
  if (!modelSpec) {
    if (!ctx.model) {
      throw new Error("No active PI model is selected. Pick a model first or configure codex.defaultReviewModel.");
    }
    return ctx.model;
  }

  const separator = modelSpec.indexOf("/");
  if (separator <= 0 || separator === modelSpec.length - 1) {
    throw new Error(`Model override "${modelSpec}" must use provider/modelId format.`);
  }

  const provider = modelSpec.slice(0, separator);
  const modelId = modelSpec.slice(separator + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Model ${modelSpec} is not available in the current PI registry.`);
  }
  return model;
}

async function runModelCompletion(
  ctx: ExtensionCommandContext,
  title: string,
  model: Model<any>,
  systemPrompt: string,
  prompt: string,
  thinkingLevel?: CodexThinkingLevel,
  externalSignal?: AbortSignal,
): Promise<string> {
  const auth = await requireModelAuth(ctx, model);

  const request = async (signal?: AbortSignal): Promise<string> => {
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      {
        systemPrompt,
        messages: [message],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: reasoningLevelForCompletion(thinkingLevel),
        signal,
      },
    );

    if (response.stopReason === "aborted") {
      throw new Error("Review cancelled.");
    }

    return response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  };

  if (!ctx.hasUI) {
    return request(externalSignal);
  }

  const result = await ctx.ui.custom<
    { status: "ok"; value: string } | { status: "cancelled" } | { status: "error"; message: string }
  >((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, title);
    loader.onAbort = () => done({ status: "cancelled" });

    request(loader.signal)
      .then((value) => done({ status: "ok", value }))
      .catch((error) => {
        console.error(`[pi-codex] ${title} failed:`, error);
        const message = error instanceof Error ? error.message : String(error);
        done({ status: "error", message });
      });

    return loader;
  });

  if (result.status === "cancelled") {
    throw new Error("Review cancelled.");
  }
  if (result.status === "error") {
    throw new Error(result.message);
  }

  return result.value;
}

export async function requireModelAuth(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
  model: Model<any>,
): Promise<{ apiKey: string; headers: Record<string, string> | undefined }> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
  if (!auth.apiKey) {
    throw new Error(`No API key or OAuth token is available for ${model.provider}/${model.id}.`);
  }

  return {
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}

export function buildStructuredReviewPrompt(
  kind: "review" | "adversarial-review",
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
): string {
  return interpolatePrompt(kind === "adversarial-review" ? ADVERSARIAL_REVIEW_PROMPT : REVIEW_PROMPT, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: focusText?.trim() || "(none)",
    REVIEW_INPUT: reviewInput,
  });
}

export async function executePreparedReviewRun(
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  input: PreparedReviewExecutionInput,
  options: { persist?: boolean; signal?: AbortSignal } = {},
): Promise<StoredReviewRun> {
  const model = resolveModel(ctx, settings, input.modelSpec);
  const effectiveThinkingLevel = resolveEffectiveThinkingLevel(model, input.thinkingLevel);
  const startedAt = new Date().toISOString();
  const prompt = buildStructuredReviewPrompt(input.kind, input.targetLabel, input.focusText, input.reviewInput);
  const rawOutput = await runModelCompletion(
    ctx,
    input.kind === "adversarial-review" ? "Running Codex adversarial review..." : "Running Codex review...",
    model,
    "You are Codex. Follow the review contract exactly and return only the requested JSON.",
    prompt,
    effectiveThinkingLevel,
    options.signal,
  );

  const parsed = parseStructuredReviewOutput(rawOutput);
  const completedAt = new Date().toISOString();
  const run: StoredReviewRun = {
    id: input.id ?? generateReviewId(input.kind === "adversarial-review" ? "adversarial-review" : "review"),
    kind: input.kind,
    createdAt: completedAt,
    startedAt,
    completedAt,
    repoRoot: input.repoRoot,
    branch: input.branch,
    targetLabel: input.targetLabel,
    targetMode: input.targetMode,
    targetBaseRef: input.targetBaseRef,
    modelProvider: model.provider,
    modelId: model.id,
    thinkingLevel: effectiveThinkingLevel,
    focusText: input.focusText?.trim() || undefined,
    result: parsed.parsed,
    parseError: parsed.parseError,
    rawOutput: parsed.rawOutput,
  };

  if (options.persist ?? true) {
    storeReviewRun(input.repoRoot, run, settings.reviewHistoryLimit);
  }

  return run;
}

export async function executeReviewRun(
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  kind: "review" | "adversarial-review",
  options: ReviewCommandOptions,
): Promise<StoredReviewRun> {
  const target = resolveReviewTarget(ctx.cwd, {
    scope: options.scope ?? settings.defaultReviewScope,
    base: options.base,
  });
  const reviewContext = collectReviewContext(ctx.cwd, target);
  return executePreparedReviewRun(ctx, settings, {
    kind,
    repoRoot: reviewContext.repoRoot,
    branch: reviewContext.branch,
    targetLabel: reviewContext.target.label,
    targetMode: reviewContext.target.mode,
    targetBaseRef: reviewContext.target.baseRef,
    reviewInput: reviewContext.content,
    modelSpec: options.modelSpec,
    thinkingLevel: options.thinkingLevel,
    focusText: options.focusText,
  });
}
