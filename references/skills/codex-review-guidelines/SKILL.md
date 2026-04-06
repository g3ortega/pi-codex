---
name: codex-review-guidelines
description: Use when you want a Codex-style review mindset inside PI, focused on bugs, regressions, unsafe assumptions, and missing tests rather than style commentary.
---

# Codex Review Guidelines

Use this when you need a review mindset inside PI.

## Rules

- prioritize bugs, regressions, unsafe assumptions, and missing tests
- prefer a compact set of strong findings over a long weak list
- do not stop after the first strong finding if other material issues are supportable
- cite exact files and lines when you can support them
- avoid style-only feedback unless it hides a functional problem
- if there are no material findings, say so explicitly

## Suggested commands

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:adversarial_mental_models_review`
- `/codex:status`
- `/codex:result`
