# pi-codex

Unofficial Codex-inspired research, review, and task workflows for the [PI coding agent](https://github.com/badlogic/pi-mono), built in a PI-native way.

This project is maintained at `g3ortega/pi-codex` and is based on Codex-oriented workflow ideas from OpenAI. It is not an official OpenAI package.

Tested with PI `0.65.0`.

## Current scope

This first implementation focuses on:

- evidence-first research handoffs
- structured repository reviews
- adversarial reviews
- background review and research jobs with completion notifications back into the originating PI session
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

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:research`
- `/codex:task`
- `/codex:status`
- `/codex:jobs`
- `/codex:result`
- `/codex:apply`
- `/codex:cancel`
- `/codex:config`

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
- `codex-prompt-task`
- `codex-prompt-research`

It also includes workflow guideline skill docs under `references/skills/`.

These files are reference material, not auto-registered PI prompts or skills. They are intentionally kept out of PI's top-level `prompts/` and `skills/` auto-discovery paths to avoid duplicate-resource collisions when you work inside the `pi-codex` repo while the package is also installed globally.

Use the `/codex:*` commands when you want the actual packaged workflow.

The packaged workflow commands intentionally use the colon names:

- `/codex:review`
- `/codex:adversarial-review`
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

Run a structured review of the current repository state:

```bash
/codex:review
/codex:review --scope working-tree
/codex:review --base origin/main
/codex:review --background --scope working-tree
```

`/codex:review` stays non-steerable by design. If you want to challenge a specific decision or risk area, use `/codex:adversarial-review`.

Run a harsher blocking review:

```bash
/codex:adversarial-review
/codex:adversarial-review --scope branch
/codex:adversarial-review --background --scope branch
```

Queue a Codex-oriented implementation request into the active PI session:

```bash
/codex:task investigate why auth refresh sometimes fails
/codex:task --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --write implement the auth refresh retry fix
```

`/codex:task` now treats `--readonly`, `--write`, `--background`, and `--model` as host-side execution flags instead of forwarding them into the natural-language task text.

Current task boundary:

- inline `/codex:task` runs in the current PI session
- `--readonly` keeps the task read-only and asks for diagnosis or a proposed patch instead of edits
- `--write` is explicit but matches the current default inline behavior
- `/codex:task --background --readonly ...` runs in a detached readonly worker and notifies the originating PI session on completion
- `/codex:task --background --write ...` runs in a detached write-capable worker inside an isolated git worktree and returns a stored patch artifact
- apply a completed write-task patch back to the live repo with `/codex:apply <job-id>`
- background `task-write` currently uses `read`, `grep`, `find`, `ls`, `edit`, and `write`, plus any already-active web tools. `bash` is intentionally not exposed in this worker profile yet.

Queue a Codex-oriented research request into the active PI session:

```bash
/codex:research compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research deeply inspect the repo, then use web tools if available to validate the best package architecture
/codex:research --background summarize the repo and key commands
```

Background research runs in a detached PI child session with a headless-safe tool surface:

- safe read-only built-ins: `read`, `grep`, `find`, `ls`
- active web research tools only when they were already active in the launching PI session
- no mutation tools in the detached child

Background jobs notify the originating PI session when they complete, fail, or are cancelled, so you can keep working in the main thread without polling.
Short stored results are inlined directly into the completion notification; longer results show an answer-first preview with exact follow-up commands such as `/codex:result <job-id>` or `/codex:apply <job-id>`.

Inspect stored review history for the current workspace:

```bash
/codex:status
/codex:jobs
/codex:result
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
- live session handoff for research and task execution
- safety by composition, not tool takeover
- protected paths should win before generic bash confirmation
- optional future bridge for exact Codex CLI semantics
