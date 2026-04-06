# pi-codex

Unofficial Codex-inspired research, review, and task workflows for the [PI coding agent](https://github.com/badlogic/pi-mono), built in a PI-native way.

This project is maintained at `g3ortega/pi-codex` and is based on Codex-oriented workflow ideas from OpenAI. It is not an official OpenAI package.

Tested with PI `0.65.0`.

## Current scope

The current implementation focuses on:

- evidence-first research handoffs
- structured repository reviews
- adversarial reviews
- background review, research, readonly task, and isolated write-task jobs with completion notifications back into the originating PI session
- project-aware Codex settings
- protected-path guards for `write`, `edit`, and `bash` commands that target protected paths unless the command is explicitly read-only
- compatibility with PI ecosystem safety packages

It intentionally does not try to replace PI's built-in tools or recreate the Codex CLI runtime wholesale.

## What this package bundles

- `pi-show-diffs`
- `pi-bash-confirm`
- `@juanibiapina/pi-extension-settings`

That gives the package strong write and shell safety defaults without taking over the PI runtime.

## Recommended companion package

- `pi-web-access`

`/codex:research` automatically adapts to active PI research tools such as `web_search`, `code_search`, `fetch_content`, and `get_search_content` when that package is installed and enabled.

## Commands

- `/codex:review` for structured repository review
- `/codex:adversarial-review` for harsher, no-ship-oriented review
- `/codex:adversarial_mental_models_review` for a deeper multi-lens adversarial review
- `/codex:research` for evidence-first investigation
- `/codex:task` for inline or background implementation work
- `/codex:status` for a single job or recent review status
- `/codex:jobs` for background job overview
- `/codex:result` for stored job or review output
- `/codex:apply` for completed background write-task patches
- `/codex:cancel` for active background jobs
- `/codex:config` for merged `pi-codex` settings

PI command autocomplete can show common flags such as `--background`, `--scope`, `--readonly`, `--write`, `--model`, `--thinking`, and `--last`.

Alias commands are also registered:

- `/codex-status`
- `/codex-jobs`
- `/codex-result`
- `/codex-apply`
- `/codex-cancel`
- `/codex-config`

## Reference prompts and skills

The repo includes reusable prompt templates under `references/prompts/`:

- `codex-prompt-review`
- `codex-prompt-adversarial-review`
- `codex-prompt-adversarial-mental-models-review`
- `codex-prompt-task`
- `codex-prompt-research`

It also includes workflow guideline skill docs under `references/skills/`.

These files are reference material, not auto-registered PI prompts or skills. They are intentionally kept out of PI's top-level `prompts/` and `skills/` auto-discovery paths to avoid duplicate-resource collisions when you work inside the `pi-codex` repo while the package is also installed globally.

Use the `/codex:*` commands when you want the actual packaged workflow.

The packaged workflow commands intentionally use the colon names:

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:adversarial_mental_models_review`
- `/codex:task`
- `/codex:research`

Legacy prompt-template names such as `/codex-review` and `/codex-adversarial-review` are blocked with guidance instead of being expanded, to avoid accidental bash-confirmation flows.

## Install

Directly from GitHub:

```bash
pi install https://github.com/g3ortega/pi-codex
```

Over SSH:

```bash
pi install git:git@github.com:g3ortega/pi-codex.git
```

From a local clone:

```bash
git clone git@github.com:g3ortega/pi-codex.git
cd pi-codex
pi install .
```

Or, after `npm install`, use the helper script:

```bash
npm install
npm run install:pi
```

Before publishing, run the local checks:

```bash
npm test
```

Or add the package to `.pi/settings.json` manually:

```json
{
  "packages": [
    "/absolute/path/to/pi-codex"
  ]
}
```

## Usage

Common retrieval flow:

```bash
/codex:jobs
/codex:status
/codex:result --last
/codex:result <job-id>
```

Run a structured review of the current repository state:

```bash
/codex:review
/codex:review --scope working-tree
/codex:review --base origin/main
/codex:review --thinking high
/codex:review --background --scope working-tree
```

`/codex:review` stays non-steerable by design. If you want to challenge a specific decision or risk area, use `/codex:adversarial-review`.

Review prompts are tuned to keep looking for a compact set of all supportable material issues in the changed surfaces, not just the first plausible finding. For the deepest pass, prefer `--thinking xhigh`.

Run a harsher blocking review:

```bash
/codex:adversarial-review
/codex:adversarial-review --thinking xhigh
/codex:adversarial-review --scope branch
/codex:adversarial-review --background --scope branch
```

`/codex:adversarial-review` stays the lighter adversarial review mode, but it is now tuned to keep checking adjacent risky surfaces instead of stopping at the first plausible issue.

Run the deepest adversarial review:

```bash
/codex:adversarial_mental_models_review --thinking xhigh
/codex:adversarial_mental_models_review --background --scope working-tree
```

`/codex:adversarial_mental_models_review` runs a deeper adversarial review pipeline: Inverter, Boundary Prober, and Invariant Auditor passes run in parallel, then a final aggregation pass merges corroborated findings, ruled-out concerns, and remaining uncertainties into one stored review result.

Queue a Codex-oriented implementation request into the active PI session:

```bash
/codex:task investigate why auth refresh sometimes fails
/codex:task --thinking high investigate why auth refresh sometimes fails
/codex:task --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --readonly --thinking xhigh diagnose the failing auth refresh flow and propose a patch
/codex:task --background --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --write implement the auth refresh retry fix
```

`/codex:task` now treats `--readonly`, `--write`, `--background`, `--model`, and `--thinking` as host-side execution flags instead of forwarding them into the natural-language task text.

Current task boundary:

- inline `/codex:task` runs in the current PI session
- if you omit `--thinking`, inline and background tasks inherit the current PI session thinking level
- inline `/codex:task --thinking ...` temporarily overrides the current PI session thinking level for the injected turn only; if the agent is already streaming, use `--background` or wait until the session is idle
- `--readonly` keeps the task read-only and asks for diagnosis or a proposed patch instead of edits
- `--write` is explicit but matches the current default inline behavior
- `/codex:task --background --readonly ...` runs in a detached readonly worker and notifies the originating PI session on completion
- `/codex:task --background --write ...` runs in a detached write-capable worker inside an isolated git worktree and returns a stored patch artifact
- apply a completed write-task patch back to the live repo with `/codex:apply <job-id>`
- background `task-write` currently uses `read`, `grep`, `find`, `ls`, `edit`, and `write`, plus any already-active web tools. `bash` is intentionally not exposed in this worker profile yet.

Queue a Codex-oriented research request into the active PI session:

```bash
/codex:research compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research --thinking high compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research deeply inspect the repo, then use web tools if available to validate the best package architecture
/codex:research --background summarize the repo and key commands
/codex:research --background --thinking xhigh summarize the repo and key commands
```

Background research runs in a detached PI child session with a headless-safe tool surface:

- safe read-only built-ins: `read`, `grep`, `find`, `ls`
- active web research tools only when they were already active in the launching PI session
- no mutation tools in the detached child

Current research boundary:

- inline `/codex:research` runs in the current PI session
- if you omit `--thinking`, inline and background research inherit the current PI session thinking level
- inline `/codex:research --thinking ...` temporarily overrides the current PI session thinking level for the injected turn only; if the agent is already streaming, use `--background` or wait until the session is idle
- background `/codex:research --thinking ...` runs in a detached readonly worker and preserves the selected thinking level in job launch, status, and result views

All major `pi-codex` workflows accept `--thinking off|minimal|low|medium|high|xhigh`:

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:adversarial_mental_models_review`
- `/codex:task`
- `/codex:research`

When omitted, `pi-codex` inherits the current PI session thinking level and clamps it to the selected model's capabilities.

Background jobs notify the originating PI session when they complete, fail, or are cancelled, so you can keep working in the main thread without polling.
Short stored results are inlined directly into the completion notification; longer results show an answer-first preview with exact follow-up commands such as `/codex:result --last`, `/codex:result <job-id>`, or `/codex:apply <job-id>`.
Detached research and task workers use a progress-aware watchdog: they fail on prolonged inactivity, but ongoing session activity extends the run up to a larger hard cap.
Background job status and stored results include queue delay, run duration, and total duration. Stored synchronous review results include total duration as well.

Inspect stored review history for the current workspace:

```bash
/codex:status
/codex:jobs
/codex:result
/codex:result --last
/codex:result review-m123abc
/codex:apply task-m123abc
/codex:cancel review-m123abc
```

## Configuration

Config is merged from:

1. built-in defaults
2. `~/.pi/agent/settings-extensions.json` under `codex`
3. `~/.pi/agent/settings.json` under `codex`
4. `.pi/settings.json` under `codex`

You can also open `/extension-settings` to manage the global extension-backed values.

`pi-codex` stores its own review and background-job state under the active PI agent directory. If you run PI with `PI_CODING_AGENT_DIR=/some/path`, the package follows that location instead of always writing to the global `~/.pi/agent`.

Current settings:

- `defaultReviewScope`
- `defaultReviewModel`
- `reviewHistoryLimit`
- `protectLockfiles`
- `enableTaskCommand`
- `enableResearchCommand`
- `protectedPaths`

## Design principles

- PI-native control plane
- direct model calls for deterministic review workflows
- foreground session handoff for inline research and task execution
- detached workers for background review, research, and task execution
- safety by composition, not tool takeover
- protected paths should win before generic bash confirmation
- optional future bridge for exact Codex CLI semantics
