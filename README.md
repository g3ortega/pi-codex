# pi-codex

Unofficial Codex-inspired research, review, and task workflows for the [PI coding agent](https://github.com/badlogic/pi-mono), built in a PI-native way.

This project is maintained at `g3ortega/pi-codex` and is based on Codex-oriented workflow ideas from OpenAI. It is not an official OpenAI package.

Tested with PI `0.65.0`.

## Current scope

This first implementation focuses on:

- evidence-first research handoffs
- structured repository reviews
- adversarial reviews
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
- `/codex:result`
- `/codex:config`

Alias commands are also registered:

- `/codex-review`
- `/codex-adversarial-review`
- `/codex-research`
- `/codex-task`
- `/codex-status`
- `/codex-result`
- `/codex-config`

## Prompt templates

The package also ships reusable prompt templates under `prompts/`:

- `codex-review`
- `codex-adversarial-review`
- `codex-task`
- `codex-research`

Use those when you want lightweight prompt steering. Use the `/codex:*` commands when you want the full packaged workflow.

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
```

`/codex:review` stays non-steerable by design. If you want to challenge a specific decision or risk area, use `/codex:adversarial-review`.

Run a harsher blocking review:

```bash
/codex:adversarial-review
/codex:adversarial-review --scope branch
```

Queue a Codex-oriented implementation request into the active PI session:

```bash
/codex:task investigate why auth refresh sometimes fails
```

Queue a Codex-oriented research request into the active PI session:

```bash
/codex:research compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research deeply inspect the repo, then use web tools if available to validate the best package architecture
```

Inspect stored review history for the current workspace:

```bash
/codex:status
/codex:result
/codex:result review-m123abc
```

## Configuration

Config is merged from:

1. built-in defaults
2. `~/.pi/agent/settings-extensions.json` under `codex`
3. `~/.pi/agent/settings.json` under `codex`
4. `.pi/settings.json` under `codex`

You can also open `/extension-settings` to manage the global extension-backed values.

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
