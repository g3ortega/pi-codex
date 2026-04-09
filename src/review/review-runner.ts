import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
import { reviewKindIdPrefix, type CodexReviewKind } from "./review-kind.js";

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
  kind: CodexReviewKind;
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
Return a compact set of strong findings rather than a long weak list.
Avoid style feedback unless it hides a real risk.
</review_method>

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check the happy path, failure path, retries, rollback or recovery behavior, stale or partial state, concurrency or ordering assumptions, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<adjacent_evidence>
Use the adjacent evidence excerpts to verify, sharpen, or dismiss the candidate findings.
If the excerpt weakens a finding, drop or downgrade it.
If it reveals a nearby second issue in the same risky surface, include it if it is material.
{{ADJACENT_EVIDENCE}}
</adjacent_evidence>

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
After you find the first plausible issue, keep looking for other material issues in adjacent changed paths before you finalize.
Check for missing guards, empty-state behavior, retries, stale state, rollback risk, compatibility edge cases, and test gaps.
</dig_deeper_nudge>

<verification_loop>
Before finalizing, verify that you have inspected the highest-risk changed surfaces and that each reported issue is still material after considering nearby guards, call sites, and tests.
If a concern weakens under closer inspection, drop it instead of padding the list.
</verification_loop>

<approval_bar>
Do not return "approve" unless you explicitly ruled out at least two concrete failure hypotheses using nearby code, guards, tests, or other repository evidence.
If you still have a materially important blind spot, keep it in uncertainties rather than glossing over it.
</approval_bar>

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
  "ruled_out": string[],
  "uncertainties": string[],
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
Prefer a compact set of strong findings over a long weak list.
Do not stop after the first strong finding if other material issues are supportable from the provided context.
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

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check auth and trust boundaries, state transitions, retries, rollback or recovery behavior, stale or partial state, ordering assumptions, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<adjacent_evidence>
Use the adjacent evidence excerpts to verify, sharpen, or dismiss the candidate findings.
If the excerpt weakens a finding, drop or downgrade it.
If it reveals a nearby second no-ship issue in the same risky surface, include it if it is material.
{{ADJACENT_EVIDENCE}}
</adjacent_evidence>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<dig_deeper_nudge>
After the first supportable issue, keep looking for additional independent no-ship risks before you finalize.
Probe for second-order failures, retries, rollback gaps, hidden dependency assumptions, stale state, and detection or recovery blind spots.
</dig_deeper_nudge>

<verification_loop>
Before finalizing, verify that you checked the highest-risk changed surfaces and that each issue would still matter in a realistic failure scenario.
If a concern becomes weak under closer inspection, drop it instead of padding the list.
</verification_loop>

<approval_bar>
Do not return "approve" unless you actively challenged at least two independent failure hypotheses in the highest-risk surfaces and could not support them after closer inspection.
If a realistic no-ship concern remains unresolved, keep the verdict at "needs-attention" or surface the uncertainty explicitly.
</approval_bar>

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
  "ruled_out": string[],
  "uncertainties": string[],
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
Prefer a compact set of strong findings over a long weak list.
Do not stop after the first strong finding if other material issues are supportable from the provided context.
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

const REVIEW_SYNTHESIS_PROMPT = `<role>
You are Codex finalizing a software review.
A first-pass draft review already exists. Your job is to verify it, deepen it, and return the final structured review.
</role>

<task>
Re-review the provided repository context and the candidate review draft.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<review_goal>
Treat the candidate review as provisional.
Verify each candidate finding against the repository context.
Remove weak or unsupported concerns.
Look for additional material issues the draft may have missed in adjacent risky surfaces.
</review_goal>

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check the happy path, failure path, retries, rollback or recovery behavior, stale or partial state, concurrency or ordering assumptions, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<finalization_rules>
Keep only material findings.
Merge duplicates and keep the clearest wording.
If the draft missed a material issue, add it.
If the draft overstates an issue, downgrade or drop it.
Keep ruled-out concerns only when a specific mechanism blocks the failure.
Surface uncertainties only when they materially limit confidence.
Do not stop just because the draft already has one strong finding.
</finalization_rules>

<approval_bar>
Do not return "approve" unless the final pass can explicitly rule out at least two concrete failure hypotheses using nearby code, guards, tests, or other repository evidence.
</approval_bar>

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
  "ruled_out": string[],
  "uncertainties": string[],
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

<candidate_review>
{{CANDIDATE_REVIEW}}
</candidate_review>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`;

const ADVERSARIAL_REVIEW_SYNTHESIS_PROMPT = `<role>
You are Codex finalizing an adversarial software review.
A first-pass adversarial draft already exists. Your job is to verify it, deepen it, and return the final blocking review.
</role>

<task>
Re-review the provided repository context and the candidate adversarial review draft.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<operating_stance>
Treat the candidate review as provisional.
Actively look for missing no-ship risks, overstatements, and hidden dependency assumptions.
Do not stop because the draft already found one strong issue.
</operating_stance>

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check auth and trust boundaries, state transitions, retries, rollback or recovery behavior, stale or partial state, ordering assumptions, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<finalization_rules>
Keep only material adversarial findings.
Merge duplicates and keep the clearest wording.
If the draft missed an independent no-ship issue, add it.
If the draft overstates a concern, downgrade or drop it.
Keep ruled-out concerns only when a specific mechanism blocks the failure.
Surface uncertainties only when they materially limit confidence.
</finalization_rules>

<approval_bar>
Do not return "approve" unless the final pass tried and failed to support at least two independent failure hypotheses in the highest-risk surfaces.
</approval_bar>

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
  "ruled_out": string[],
  "uncertainties": string[],
  "next_steps": string[]
}

Use "needs-attention" if there is any material blocking risk.
Use "approve" only if you cannot support any substantive adversarial finding from the provided context.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context.
Do not invent files, line numbers, incidents, attack chains, or runtime behavior you cannot support.
</grounding_rules>

<candidate_review>
{{CANDIDATE_REVIEW}}
</candidate_review>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`;

type MentalModelLens = "inverter" | "boundary-prober" | "invariant-auditor";

const REVIEW_INSPECTION_PROMPT = `<role>
You are Codex preparing a software review.
Your job is to inspect the highest-risk changed surfaces and collect concrete leads before the final review.
</role>

<task>
Inspect the provided repository context and identify the highest-risk places to verify.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<inspection_method>
Look at the materially changed files first, then the nearby guards, callers, tests, config, and previous-version context most likely to change the verdict.
Prefer concrete failure hypotheses over generic risk categories.
If a likely issue depends on a nearby guard, test, callback, transaction boundary, retry path, or ordering assumption, note that dependency explicitly.
Keep the inspection bounded: after the changed files, inspect only the highest-value adjacent evidence needed to confirm or dismiss the top hypotheses.
Keep the inspection proportional to the change radius. If the diff is docs-only, comment-only, or test-only, do not audit unrelated production code unless the change itself makes a concrete behavioral claim that needs verification.
If the change spans many files or more than one subsystem, inspect multiple independent high-risk surfaces before you stop. Do not anchor on the first hot file if another changed surface could fail differently.
Prefer diff/show/status/log-style inspection and direct nearby reads over broad history walks or archaeology.
Use blame or older history only when it is needed to confirm or dismiss a specific regression hypothesis.
Stop once you have a compact set of substantiated candidate failures and the main risky hypotheses are either supported or explicitly weakened.
</inspection_method>

<output_contract>
Return concise markdown only with these headings:
## High-risk surfaces
## Adjacent evidence to inspect
## Candidate failure hypotheses
## Safeguards already visible
## Remaining gaps

Keep it compact and concrete. Do not return the final review yet.
Do not exhaustively inventory the repository or narrate every command you ran.
</output_contract>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`;

type MentalModelLensResult = {
  lens: MentalModelLens;
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    title: string;
    body: string;
    file: string;
    line_start: number | null;
    line_end: number | null;
    confidence: number | null;
    recommendation: string;
  }>;
  ruled_out: string[];
  uncertainties: string[];
};

const MENTAL_MODEL_LENS_PROMPTS: Record<MentalModelLens, string> = {
  inverter: `<role>
You are the Inverter, a hostile correctness reviewer.
Your only job is to construct concrete failure paths and break confidence in the change.
</role>

<task>
Review the provided repository context using inversion and pre-mortem thinking.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<lens_method>
For every plausible claim of correctness, try to negate it with a step-by-step failure path.
Assume duplicated work, lost work, wrong selection, corrupted state, and silent failure have already happened, then trace backwards through the code.
If a path does not break, state the exact guard or mechanism that blocks it.
</lens_method>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<structured_output_contract>
Return only valid JSON matching this shape:
{
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
  "ruled_out": string[],
  "uncertainties": string[]
}

Return a compact set of the strongest material findings for this lens only.
Do not return filler or style commentary.
</structured_output_contract>

<grounding_rules>
Every finding must be defensible from the provided repository context.
Do not invent files, line numbers, or unsupported runtime behavior.
If a concern stays hypothetical, keep confidence honest or move it to uncertainties.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`,
  "boundary-prober": `<role>
You are the Boundary Prober, a reviewer focused on edges, not comfortable middle cases.
</role>

<task>
Review the provided repository context by probing the boundaries where behavior changes.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<lens_method>
Inspect conditionals, guards, query selection, and type boundaries.
Reason at the boundary: nil, empty, zero, exact equality, duplicate matches, ordering ties, version skew, and coercion edges.
If a boundary looks safe, state the exact mechanism or test that makes it safe.
</lens_method>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<structured_output_contract>
Return only valid JSON matching this shape:
{
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
  "ruled_out": string[],
  "uncertainties": string[]
}

Return a compact set of the strongest material findings for this lens only.
Do not return filler or style commentary.
</structured_output_contract>

<grounding_rules>
Every finding must be defensible from the provided repository context.
Do not invent files, line numbers, or unsupported runtime behavior.
If a concern stays hypothetical, keep confidence honest or move it to uncertainties.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`,
  "invariant-auditor": `<role>
You are the Invariant Auditor, a reviewer focused on what must always stay true.
</role>

<task>
Review the provided repository context by identifying invariants and checking whether the change preserves them under all relevant transitions.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<lens_method>
Identify domain, data-integrity, ordering, and state-transition invariants.
Check whether writes stay atomic enough, whether retries preserve invariants, and whether removed code dropped a protection that still needs to exist.
If an invariant appears preserved, state the mechanism that preserves it.
</lens_method>

<inspection_notes>
Use the inspection notes as leads, not as truth.
Re-verify the serious ones against the repository context before finalizing.
{{INSPECTION_NOTES}}
</inspection_notes>

<structured_output_contract>
Return only valid JSON matching this shape:
{
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
  "ruled_out": string[],
  "uncertainties": string[]
}

Return a compact set of the strongest material findings for this lens only.
Do not return filler or style commentary.
</structured_output_contract>

<grounding_rules>
Every finding must be defensible from the provided repository context.
Do not invent files, line numbers, or unsupported runtime behavior.
If a concern stays hypothetical, keep confidence honest or move it to uncertainties.
</grounding_rules>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
`,
};

const MENTAL_MODELS_AGGREGATION_PROMPT = `<role>
You are Codex aggregating three specialized adversarial review passes.
Your job is to merge only grounded, material findings into one compact final verdict.
</role>

<task>
Synthesize the mental-model review outputs into a final structured review.
Target: {{TARGET_LABEL}}
User focus: {{USER_FOCUS}}
</task>

<aggregation_rules>
Treat corroborated findings as higher confidence.
Merge duplicates and keep the clearest wording.
Keep ruled-out concerns only when a specific mechanism blocked the failure.
Surface uncertainties when they materially limit confidence.
Do not invent concerns that were not supported by the lens outputs.
Use the adjacent evidence excerpts to corroborate, sharpen, or dismiss the candidate findings before finalizing.
</aggregation_rules>

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
  "ruled_out": string[],
  "uncertainties": string[],
  "next_steps": string[]
}

Use "needs-attention" if any material blocking issue remains.
Use "approve" only if no material finding is supportable from the lens outputs.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
In finding bodies, mention corroborating lenses when more than one lens supports the issue.
</structured_output_contract>

<grounding_rules>
Base the final answer on the supplied lens outputs.
Do not invent files, line numbers, or runtime behavior beyond what the lens outputs support.
</grounding_rules>

<adjacent_evidence>
{{ADJACENT_EVIDENCE}}
</adjacent_evidence>

<lens_outputs>
{{LENS_OUTPUTS}}
</lens_outputs>
`;

function interpolatePrompt(
  template: string,
  values: Record<"TARGET_LABEL" | "USER_FOCUS" | "REVIEW_INPUT" | "INSPECTION_NOTES", string>,
): string {
  return template
    .replaceAll("{{TARGET_LABEL}}", values.TARGET_LABEL)
    .replaceAll("{{USER_FOCUS}}", values.USER_FOCUS)
    .replaceAll("{{INSPECTION_NOTES}}", values.INSPECTION_NOTES)
    .replaceAll("{{REVIEW_INPUT}}", values.REVIEW_INPUT);
}

function interpolateMentalModelsAggregationPrompt(
  template: string,
  values: Record<"TARGET_LABEL" | "USER_FOCUS" | "LENS_OUTPUTS" | "ADJACENT_EVIDENCE", string>,
): string {
  return template
    .replaceAll("{{TARGET_LABEL}}", values.TARGET_LABEL)
    .replaceAll("{{USER_FOCUS}}", values.USER_FOCUS)
    .replaceAll("{{ADJACENT_EVIDENCE}}", values.ADJACENT_EVIDENCE)
    .replaceAll("{{LENS_OUTPUTS}}", values.LENS_OUTPUTS);
}

function interpolateReviewSynthesisPrompt(
  template: string,
  values: Record<"TARGET_LABEL" | "USER_FOCUS" | "CANDIDATE_REVIEW" | "REVIEW_INPUT" | "INSPECTION_NOTES" | "ADJACENT_EVIDENCE", string>,
): string {
  return template
    .replaceAll("{{TARGET_LABEL}}", values.TARGET_LABEL)
    .replaceAll("{{USER_FOCUS}}", values.USER_FOCUS)
    .replaceAll("{{CANDIDATE_REVIEW}}", values.CANDIDATE_REVIEW)
    .replaceAll("{{INSPECTION_NOTES}}", values.INSPECTION_NOTES)
    .replaceAll("{{ADJACENT_EVIDENCE}}", values.ADJACENT_EVIDENCE)
    .replaceAll("{{REVIEW_INPUT}}", values.REVIEW_INPUT);
}

function formatInspectionNotes(inspectionNotes: string | undefined): string {
  const trimmed = inspectionNotes?.trim();
  return formatPromptSupplement(trimmed, 12_000, "Inspection notes");
}

function formatAdjacentEvidence(adjacentEvidence: string | undefined): string {
  const trimmed = adjacentEvidence?.trim();
  return formatPromptSupplement(trimmed, 8_000, "Adjacent evidence");
}

function formatPromptSupplement(value: string | undefined, maxChars: number, label: string): string {
  if (!value || value.length === 0) {
    return "(none)";
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}\n\n[${label} truncated after ${maxChars} characters.]`;
}

function normalizeMentalModelLine(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function normalizeMentalModelConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeMentalModelSeverity(value: unknown): "critical" | "high" | "medium" | "low" {
  return value === "critical" || value === "high" || value === "medium" ? value : "low";
}

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenced ? fenced[1].trim() : trimmed;
  if (unfenced.startsWith("{") && unfenced.endsWith("}")) {
    return unfenced;
  }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

export function reviewAbortError(signal: AbortSignal | undefined, fallbackMessage = "Review cancelled."): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.trim()) {
    return new Error(reason.trim());
  }
  if (reason !== undefined) {
    return new Error(String(reason));
  }
  return new Error(fallbackMessage);
}

function parseMentalModelLensOutput(lens: MentalModelLens, rawOutput: string): MentalModelLensResult {
  const parsed = JSON.parse(extractJsonCandidate(rawOutput)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Mental-model lens "${lens}" did not return a JSON object.`);
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`Mental-model lens "${lens}" is missing array \`findings\`.`);
  }

  return {
    lens,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : `${lens} completed.`,
    findings: parsed.findings.map((entry, index) => {
      const source = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      const lineStart = normalizeMentalModelLine(source.line_start);
      const lineEndRaw = normalizeMentalModelLine(source.line_end);
      return {
        severity: normalizeMentalModelSeverity(source.severity),
        title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `${lens} finding ${index + 1}`,
        body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
        file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
        line_start: lineStart,
        line_end: lineStart && lineEndRaw && lineEndRaw >= lineStart ? lineEndRaw : lineStart,
        confidence: normalizeMentalModelConfidence(source.confidence),
        recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : "",
      };
    }),
    ruled_out: Array.isArray(parsed.ruled_out)
      ? parsed.ruled_out.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [],
    uncertainties: Array.isArray(parsed.uncertainties)
      ? parsed.uncertainties
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
      : [],
  };
}

async function performModelCompletion(
  model: Model<any>,
  auth: { apiKey: string; headers: Record<string, string> | undefined },
  systemPrompt: string,
  prompt: string,
  thinkingLevel?: CodexThinkingLevel,
  signal?: AbortSignal,
): Promise<string> {
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
    throw reviewAbortError(signal);
  }

  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function trimInspectionSeedNotes(text: string, maxChars = 3_500): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n(inspection seeds truncated)`;
}

export async function generateInspectionSeedNotesWithCompletion(
  ctx: ExtensionCommandContext,
  model: Model<any>,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  thinkingLevel: CodexThinkingLevel | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const auth = await requireModelAuth(ctx, model);
  const notes = await performModelCompletion(
    model,
    auth,
    "You are Codex. Inspect the repository context, gather concrete review leads, and return only the requested markdown sections.",
    buildReviewInspectionPrompt(targetLabel, focusText, reviewInput),
    thinkingLevel,
    signal,
  );
  return trimInspectionSeedNotes(notes);
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
  const request = async (signal?: AbortSignal): Promise<string> =>
    performModelCompletion(model, auth, systemPrompt, prompt, thinkingLevel, signal);

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
  kind: CodexReviewKind,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  inspectionNotes?: string,
): string {
  if (kind !== "review" && kind !== "adversarial-review") {
    throw new Error(`Structured review prompt is not defined for review kind "${kind}".`);
  }

  return interpolatePrompt(kind === "adversarial-review" ? ADVERSARIAL_REVIEW_PROMPT : REVIEW_PROMPT, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: focusText?.trim() || "(none)",
    INSPECTION_NOTES: formatInspectionNotes(inspectionNotes),
    REVIEW_INPUT: reviewInput,
  });
}

export function renderCandidateReviewForSynthesis(
  rawOutput: string,
  parsed: ReturnType<typeof parseStructuredReviewOutput>["parsed"],
  parseError: string | null,
): string {
  if (parsed) {
    return formatPromptSupplement(JSON.stringify(parsed, null, 2), 10_000, "Candidate review");
  }

  if (parseError) {
    return formatPromptSupplement([
      `Draft review parse error: ${parseError}`,
      "",
      "Raw draft review output:",
      rawOutput.trim(),
    ].join("\n"), 10_000, "Candidate review");
  }

  return formatPromptSupplement(rawOutput.trim(), 10_000, "Candidate review");
}

export function buildStructuredReviewSynthesisPrompt(
  kind: Extract<CodexReviewKind, "review" | "adversarial-review">,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  candidateReview: string,
  adjacentEvidence: string | undefined,
  inspectionNotes?: string,
): string {
  return interpolateReviewSynthesisPrompt(
    kind === "adversarial-review" ? ADVERSARIAL_REVIEW_SYNTHESIS_PROMPT : REVIEW_SYNTHESIS_PROMPT,
    {
      TARGET_LABEL: targetLabel,
      USER_FOCUS: focusText?.trim() || "(none)",
      CANDIDATE_REVIEW: candidateReview,
      INSPECTION_NOTES: formatInspectionNotes(inspectionNotes),
      ADJACENT_EVIDENCE: formatAdjacentEvidence(adjacentEvidence),
      REVIEW_INPUT: reviewInput,
    },
  );
}

function renderAdjacentEvidenceExcerpt(
  repoRoot: string,
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null,
  radius = 20,
): string | null {
  const relativePath = filePath.trim();
  if (!relativePath) {
    return null;
  }
  const absolutePath = resolveSafeAdjacentEvidencePath(repoRoot, relativePath);
  if (!absolutePath) {
    return null;
  }

  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  if (lines.length === 0) {
    return null;
  }

  const safeStart = Math.max(1, lineStart ?? 1);
  const safeEnd = Math.max(safeStart, lineEnd ?? safeStart);
  const excerptStart = Math.max(1, safeStart - radius);
  const excerptEnd = Math.min(lines.length, safeEnd + radius);
  const excerpt = lines
    .slice(excerptStart - 1, excerptEnd)
    .map((line, index) => `${excerptStart + index}: ${line}`)
    .join("\n")
    .trimEnd();

  if (!excerpt) {
    return null;
  }

  return [`### ${relativePath}:${safeStart}${safeEnd > safeStart ? `-${safeEnd}` : ""}`, "```", excerpt, "```"].join("\n");
}

export function resolveSafeAdjacentEvidencePath(repoRoot: string, filePath: string): string | null {
  const trimmedPath = filePath.trim();
  if (!trimmedPath || trimmedPath.includes("\0")) {
    return null;
  }

  const lexicalPath = resolve(repoRoot, trimmedPath);
  if (!existsSync(lexicalPath)) {
    return null;
  }

  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    resolvedRoot = realpathSync(repoRoot);
    resolvedPath = realpathSync(lexicalPath);
  } catch {
    return null;
  }

  const relativePath = relative(resolvedRoot, resolvedPath);
  if (relativePath === "") {
    return resolvedPath;
  }
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }
  return resolvedPath;
}

function buildAdjacentEvidence(
  repoRoot: string,
  parsed: ReturnType<typeof parseStructuredReviewOutput>["parsed"] | null,
  maxExcerpts = 4,
): string | undefined {
  if (!parsed?.findings?.length) {
    return undefined;
  }

  const excerpts: string[] = [];
  const seen = new Set<string>();
  for (const finding of parsed.findings) {
    if (excerpts.length >= maxExcerpts) {
      break;
    }
    const key = `${finding.file}:${finding.line_start}:${finding.line_end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const excerpt = renderAdjacentEvidenceExcerpt(repoRoot, finding.file, finding.line_start, finding.line_end);
    if (excerpt) {
      excerpts.push(excerpt);
    }
  }

  return excerpts.length > 0 ? excerpts.join("\n\n") : undefined;
}

function buildAdjacentEvidenceFromMentalModelResults(
  repoRoot: string,
  lensResults: MentalModelLensResult[],
): string | undefined {
  const findings = lensResults.flatMap((result) => result.findings);
  if (findings.length === 0) {
    return undefined;
  }

  return buildAdjacentEvidence(
    repoRoot,
    {
      verdict: "needs-attention",
      summary: "mental-model evidence gathering",
      findings,
      ruled_out: [],
      uncertainties: [],
      next_steps: [],
    },
    5,
  );
}

export function buildReviewInspectionPrompt(
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
): string {
  return interpolatePrompt(REVIEW_INSPECTION_PROMPT, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: focusText?.trim() || "(none)",
    INSPECTION_NOTES: "(none)",
    REVIEW_INPUT: reviewInput,
  });
}

function buildMentalModelLensPrompt(
  lens: MentalModelLens,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  inspectionNotes?: string,
): string {
  return interpolatePrompt(MENTAL_MODEL_LENS_PROMPTS[lens], {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: focusText?.trim() || "(none)",
    INSPECTION_NOTES: formatInspectionNotes(inspectionNotes),
    REVIEW_INPUT: reviewInput,
  });
}

function buildMentalModelsAggregationPrompt(
  targetLabel: string,
  focusText: string | undefined,
  lensOutputs: MentalModelLensResult[],
  adjacentEvidence: string | undefined,
): string {
  const renderedLensOutputs = lensOutputs
    .map((output) => `## ${output.lens}\n${JSON.stringify(output, null, 2)}`)
    .join("\n\n");

  return interpolateMentalModelsAggregationPrompt(MENTAL_MODELS_AGGREGATION_PROMPT, {
    TARGET_LABEL: targetLabel,
    USER_FOCUS: focusText?.trim() || "(none)",
    ADJACENT_EVIDENCE: formatAdjacentEvidence(adjacentEvidence),
    LENS_OUTPUTS: formatPromptSupplement(renderedLensOutputs, 14_000, "Lens outputs"),
  });
}

async function executeMentalModelsStructuredReview(
  ctx: ExtensionCommandContext,
  model: Model<any>,
  repoRoot: string,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  thinkingLevel: CodexThinkingLevel | undefined,
  inspectionNotes: string | undefined,
  signal?: AbortSignal,
): Promise<{ rawOutput: string; parsed: ReturnType<typeof parseStructuredReviewOutput>["parsed"]; parseError: string | null }> {
  const auth = await requireModelAuth(ctx, model);
  const settledLensResults = await Promise.allSettled(
    (["inverter", "boundary-prober", "invariant-auditor"] as const).map(async (lens) => {
      const rawOutput = await performModelCompletion(
        model,
        auth,
        `You are Codex. Follow the ${lens} lens contract exactly and return only the requested JSON.`,
        buildMentalModelLensPrompt(lens, targetLabel, focusText, reviewInput, inspectionNotes),
        thinkingLevel,
        signal,
      );
      return parseMentalModelLensOutput(lens, rawOutput);
    }),
  );
  if (signal?.aborted) {
    throw reviewAbortError(signal);
  }
  const lensResults = settledLensResults.map((result, index) => {
    const lens = (["inverter", "boundary-prober", "invariant-auditor"] as const)[index];
    if (result.status === "fulfilled") {
      return result.value;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return {
      lens,
      summary: `${lens} did not produce a usable result.`,
      findings: [],
      ruled_out: [],
      uncertainties: [`${lens} failed before producing usable structured output: ${message}`],
    } satisfies MentalModelLensResult;
  });

  if (lensResults.every((result) => result.findings.length === 0 && result.uncertainties.length > 0)) {
    throw new Error("All mental-model review lenses failed before producing usable structured output.");
  }
  const adjacentEvidence = buildAdjacentEvidenceFromMentalModelResults(repoRoot, lensResults);

  const aggregationRawOutput = await performModelCompletion(
    model,
    auth,
    "You are Codex. Aggregate the lens outputs into the final review contract and return only the requested JSON.",
    buildMentalModelsAggregationPrompt(targetLabel, focusText, lensResults, adjacentEvidence),
    thinkingLevel,
    signal,
  );
  const parsed = parseStructuredReviewOutput(aggregationRawOutput);
  return {
    rawOutput: aggregationRawOutput,
    parsed: parsed.parsed,
    parseError: parsed.parseError,
  };
}

async function executeDeepStructuredReview(
  ctx: ExtensionCommandContext,
  model: Model<any>,
  kind: Extract<CodexReviewKind, "review" | "adversarial-review">,
  repoRoot: string,
  targetLabel: string,
  focusText: string | undefined,
  reviewInput: string,
  thinkingLevel: CodexThinkingLevel | undefined,
  inspectionNotes: string | undefined,
  signal?: AbortSignal,
): Promise<{ rawOutput: string; parsed: ReturnType<typeof parseStructuredReviewOutput>["parsed"]; parseError: string | null }> {
  const auth = await requireModelAuth(ctx, model);
  const draftRawOutput = await performModelCompletion(
    model,
    auth,
    "You are Codex. Follow the review contract exactly and return only the requested JSON.",
    buildStructuredReviewPrompt(kind, targetLabel, focusText, reviewInput, inspectionNotes),
    thinkingLevel,
    signal,
  );
  const draftParsed = parseStructuredReviewOutput(draftRawOutput);
  if (signal?.aborted) {
    throw reviewAbortError(signal);
  }
  const adjacentEvidence = buildAdjacentEvidence(repoRoot, draftParsed.parsed);

  const finalRawOutput = await performModelCompletion(
    model,
    auth,
    "You are Codex. Verify, deepen, and finalize the review. Return only the requested JSON.",
    buildStructuredReviewSynthesisPrompt(
        kind,
        targetLabel,
        focusText,
        reviewInput,
        renderCandidateReviewForSynthesis(draftRawOutput, draftParsed.parsed, draftParsed.parseError),
        adjacentEvidence,
        inspectionNotes,
      ),
      thinkingLevel,
      signal,
  );
  const finalParsed = parseStructuredReviewOutput(finalRawOutput);
  if (finalParsed.parsed) {
    return {
      rawOutput: finalRawOutput,
      parsed: finalParsed.parsed,
      parseError: finalParsed.parseError,
    };
  }

  if (draftParsed.parsed) {
    return {
      rawOutput: draftRawOutput,
      parsed: {
        ...draftParsed.parsed,
        uncertainties: [
          ...(draftParsed.parsed.uncertainties ?? []),
          "Final synthesis pass returned invalid structured output, so the first-pass review was kept.",
        ],
      },
      parseError: null,
    };
  }

  return {
    rawOutput: finalRawOutput,
    parsed: finalParsed.parsed,
    parseError: finalParsed.parseError,
  };
}

export async function executePreparedReviewRun(
  ctx: ExtensionCommandContext,
  settings: CodexSettings,
  input: PreparedReviewExecutionInput,
  options: { persist?: boolean; signal?: AbortSignal; inspectionNotes?: string } = {},
): Promise<StoredReviewRun> {
  const model = resolveModel(ctx, settings, input.modelSpec);
  const effectiveThinkingLevel = resolveEffectiveThinkingLevel(model, input.thinkingLevel);
  const startedAt = new Date().toISOString();
  const inspectionNotes =
    options.inspectionNotes ??
    (await generateInspectionSeedNotesWithCompletion(
      ctx,
      model,
      input.targetLabel,
      input.focusText,
      input.reviewInput,
      effectiveThinkingLevel,
      options.signal,
    ));
  const parsed = input.kind === "adversarial-mental-models-review"
    ? await (async () => {
      if (!ctx.hasUI) {
        return executeMentalModelsStructuredReview(
          ctx,
          model,
          input.repoRoot,
          input.targetLabel,
          input.focusText,
          input.reviewInput,
          effectiveThinkingLevel,
          inspectionNotes,
          options.signal,
        );
      }

      const title = "Running Codex adversarial mental models review...";
      const result = await ctx.ui.custom<
        { status: "ok"; value: Awaited<ReturnType<typeof executeMentalModelsStructuredReview>> } | { status: "cancelled" } | { status: "error"; message: string }
      >((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, title);
        loader.onAbort = () => done({ status: "cancelled" });

        executeMentalModelsStructuredReview(
          ctx,
          model,
          input.repoRoot,
          input.targetLabel,
          input.focusText,
          input.reviewInput,
          effectiveThinkingLevel,
          inspectionNotes,
          loader.signal,
        )
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
    })()
    : await (async () => {
      const deepKind = input.kind as Extract<CodexReviewKind, "review" | "adversarial-review">;
      if (!ctx.hasUI) {
        return executeDeepStructuredReview(
          ctx,
          model,
          deepKind,
          input.repoRoot,
          input.targetLabel,
          input.focusText,
          input.reviewInput,
          effectiveThinkingLevel,
          inspectionNotes,
          options.signal,
        );
      }

      const title = input.kind === "adversarial-review"
        ? "Running Codex adversarial review..."
        : "Running Codex review...";
      const result = await ctx.ui.custom<
        { status: "ok"; value: Awaited<ReturnType<typeof executeDeepStructuredReview>> } | { status: "cancelled" } | { status: "error"; message: string }
      >((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, title);
        loader.onAbort = () => done({ status: "cancelled" });

        executeDeepStructuredReview(
          ctx,
          model,
          deepKind,
          input.repoRoot,
          input.targetLabel,
          input.focusText,
          input.reviewInput,
          effectiveThinkingLevel,
          inspectionNotes,
          loader.signal,
        )
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
    })();
  const completedAt = new Date().toISOString();
  const run: StoredReviewRun = {
    id: input.id ?? generateReviewId(reviewKindIdPrefix(input.kind)),
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
