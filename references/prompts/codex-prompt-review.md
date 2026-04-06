---
description: Structured code review prompt for the active repository
---
<task>
Review the current repository changes for material bugs, regressions, and missing validation.
</task>

<structured_output_contract>
Return findings ordered by severity, with supporting evidence and brief next steps.
Keep the answer compact.
</structured_output_contract>

<grounding_rules>
Ground every claim in the repository context or tool outputs you inspected.
If a point is an inference, label it clearly.
Do not invent files, line numbers, or unsupported runtime behavior.
</grounding_rules>

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check the happy path, failure path, retries, rollback or recovery behavior, stale or partial state, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<pi_tooling_preference>
Prefer PI read-only tools (`find`, `ls`, `grep`, `read`) for repository inspection.
Use `bash` only when the read-only tools cannot answer the question.
</pi_tooling_preference>

<dig_deeper_nudge>
After the first plausible issue, keep looking for other material issues in adjacent changed paths before finalizing.
Check for missing guards, empty-state behavior, retries, stale state, rollback risk, compatibility edge cases, and test gaps.
</dig_deeper_nudge>

<verification_loop>
Before finalizing, verify that the highest-risk changed surfaces were inspected and that each issue is still material after considering nearby guards, call sites, and tests.
If a concern weakens under closer inspection, drop it instead of padding the list.
</verification_loop>

For the packaged git-aware workflow with persisted results and structured JSON review, prefer `/codex:review`.
