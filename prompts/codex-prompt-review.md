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

<pi_tooling_preference>
Prefer PI read-only tools (`find`, `ls`, `grep`, `read`) for repository inspection.
Use `bash` only when the read-only tools cannot answer the question.
</pi_tooling_preference>

<dig_deeper_nudge>
After the first plausible issue, check for missing guards, empty-state behavior, retries, stale state, rollback risk, compatibility edge cases, and test gaps before finalizing.
</dig_deeper_nudge>

For the packaged git-aware workflow with persisted results and structured JSON review, prefer `/codex:review`.
