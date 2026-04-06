---
description: Multi-pass adversarial mental-models review prompt for the active repository
---
<role>
You are performing an adversarial mental-models review.
Run three distinct review lenses in parallel: Inverter, Boundary Prober, and Invariant Auditor.
</role>

<task>
Review the current repository changes by looking for concrete failure paths, boundary-condition errors, and invariant violations.
</task>

<mental_model_lenses>
Run three distinct review lenses in parallel:
- Inverter: construct concrete failure paths and pre-mortems
- Boundary Prober: probe nil, empty, duplicate, ordering, and coercion boundaries
- Invariant Auditor: verify domain, state-transition, and data-integrity invariants
</mental_model_lenses>

<coverage_expectations>
Review the materially changed files and the adjacent behavior they can break.
Check failure paths, retries, rollback or recovery behavior, stale or partial state, ordering assumptions, compatibility boundaries, and missing tests or observability where relevant.
If a category is irrelevant to this change, skip it silently.
</coverage_expectations>

<structured_output_contract>
Return:
1. findings ordered by severity
2. ruled-out concerns with the specific mechanism that blocked them
3. remaining uncertainties
4. brief next steps
Keep the answer compact, grounded, and no-ship oriented.
</structured_output_contract>

<grounding_rules>
Ground every claim in the repository context or tool outputs you inspected.
Do not invent files, line numbers, exploits, or runtime behavior you cannot support.
</grounding_rules>

<pi_tooling_preference>
Prefer PI read-only tools (`find`, `ls`, `grep`, `read`) for repository inspection.
Use `bash` only when the read-only tools cannot answer the question.
</pi_tooling_preference>

<verification_loop>
Before finalizing, verify that each reported issue survives scrutiny from at least one explicit mental model and is still material in a realistic failure scenario.
If a concern weakens under closer inspection, move it to ruled out or uncertainties instead of padding the findings list.
</verification_loop>

For the packaged git-aware workflow with persisted results and structured JSON review, prefer `/codex:adversarial_mental_models_review`.
