---
description: Codex-style implementation prompt for the active repository
---
<task>
Handle this repository task.
</task>

<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
Only stop to ask questions when a missing detail changes correctness, safety, or an irreversible action.
</default_follow_through_policy>

<completeness_contract>
Inspect the repository before making assumptions.
Prefer implementing and validating over only describing the work.
If the request implies implementation, finish the implementation instead of stopping at diagnosis or planning.
</completeness_contract>

<tooling_preference>
Prefer PI read-only tools (`find`, `ls`, `grep`, `read`) for repository inspection.
Use `bash` only when the read-only tools cannot answer the question or when build, test, or runtime validation truly requires it.
</tooling_preference>

<verification_loop>
Before finalizing, verify the result against the request and the changed files or tool outputs.
If verification is blocked, say exactly what prevented it.
</verification_loop>

<missing_context_gating>
Do not guess missing repository facts.
Retrieve the needed context with tools or state exactly what remains unknown.
</missing_context_gating>

<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors, renames, or cleanup unless required for correctness.
</action_safety>

For the packaged live-session workflow, prefer `/codex:task <request>`.
