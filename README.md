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

`/codex:research` prefers native OpenAI/Codex `web_search` automatically when the selected model/provider supports it. PI research tools such as `web_search`, `code_search`, `fetch_content`, and `get_search_content` remain useful fallback or adjunct tools when they are installed and enabled.

## Commands

- `/codex:review`
  Standard code review for the current change set.
- `/codex:adversarial-review`
  Stricter review that tries to find blocking or risky issues.
- `/codex:adversarial_mental_models_review`
  Deepest review mode. Uses multiple reasoning lenses and usually takes the longest.
- `/codex:research`
  Investigate a question, using repo evidence first and native Codex web search when available.
- `/codex:task`
  Ask Codex to inspect, diagnose, propose a patch, or implement work.
- `/codex:status`
  Show one running job, or recent review/job history for the current workspace.
- `/codex:jobs`
  List recent background jobs for the current workspace.
- `/codex:result`
  Open a saved result.
- `/codex:apply`
  Apply a saved background write-task patch back to the live repo.
- `/codex:cancel`
  Stop an active background job.
- `/codex:config`
  Show the active `pi-codex` settings for this session.

PI command autocomplete can show common flags such as `--background`, `--scope`, `--readonly`, `--write`, `--model`, `--thinking`, and `--last`.

Common flags:

- `--background`
  Run the work in the background and notify the current PI session when it finishes.
- `--scope working-tree|branch`
  Review the current checkout or the full branch diff.
- `--base <ref>`
  Base ref to compare against when you use `--scope branch`.
- `--readonly`
  Inspect and explain only. Do not edit files.
- `--write`
  Allow Codex to make code changes.
- `--thinking off|minimal|low|medium|high|xhigh`
  Set reasoning effort for this one run.
- `--last`
  Open the latest saved result in the current workspace without copying a job id.

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

Quick result lookup:

```bash
/codex:jobs
/codex:status
/codex:result --last
/codex:result <job-id>
```

Run a standard review:

```bash
/codex:review
/codex:review --scope working-tree
/codex:review --base origin/main
/codex:review --thinking high
/codex:review --background --scope working-tree
```

`/codex:review` is intentionally unsteered so Codex can judge the overall change on its own. If you want to push on a specific concern or force a harsher pass, use `/codex:adversarial-review`.

Review prompts are tuned to keep looking for a compact set of all supportable material issues in the changed surfaces, not just the first plausible finding. Standard review and adversarial review now run an internal draft-plus-synthesis cycle before finalizing. For the deepest pass, prefer `--thinking xhigh`.
Background `review` and `adversarial-review` workers now run as read-only agentic reviewers with `read`, `grep`, `find`, `ls`, and inspection-only `bash` for commands such as `git diff`, `git show`, `git log`, `git status`, `git blame`, and `git merge-base`. Installed web research tools are also activated in the detached worker by default when they are available.

Run a stricter review:

```bash
/codex:adversarial-review
/codex:adversarial-review --thinking xhigh
/codex:adversarial-review --scope branch
/codex:adversarial-review --background --scope branch
```

Use `/codex:adversarial-review` when you want Codex to challenge the patch, look for no-ship issues, and spend more time disproving correctness.

Run the deepest review:

```bash
/codex:adversarial_mental_models_review --thinking xhigh
/codex:adversarial_mental_models_review --background --scope working-tree
```

Use `/codex:adversarial_mental_models_review` when you want the slowest and deepest pass. It runs multiple adversarial lenses in parallel, then combines corroborated findings, ruled-out concerns, and uncertainties into one review.

Run a task:

```bash
/codex:task investigate why auth refresh sometimes fails
/codex:task --thinking high investigate why auth refresh sometimes fails
/codex:task --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --readonly --thinking xhigh diagnose the failing auth refresh flow and propose a patch
/codex:task --background --readonly diagnose the failing auth refresh flow and propose a patch
/codex:task --background --write implement the auth refresh retry fix
```

`/codex:task` treats `--readonly`, `--write`, `--background`, `--model`, and `--thinking` as command flags. They change how the task runs; they are not forwarded into the task text.

Current task boundary:

- Inline `/codex:task` runs in the current PI session.
- If you omit `--thinking`, inline and background tasks inherit the current PI session thinking level.
- Inline `/codex:task --thinking ...` temporarily changes the current PI session thinking level for that injected turn only. If the agent is already busy, use `--background` instead.
- `--readonly` asks for inspection, diagnosis, or a proposed patch without editing files.
- `--write` allows code changes.
- `/codex:task --background --readonly ...` runs in a detached read-only worker and notifies the current PI session when it finishes.
- `/codex:task --background --write ...` runs in a detached write-capable worker inside an isolated git worktree and saves a patch artifact instead of touching the live repo directly.
- Apply a completed write-task patch with `/codex:apply <job-id>`.

Run research:

```bash
/codex:research compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research --thinking high compare PI extension APIs with Codex CLI and verify current web-tooling options
/codex:research deeply inspect the repo, then use native web search or fallback web tools to validate the best package architecture
/codex:research --background summarize the repo and key commands
/codex:research --background --thinking xhigh summarize the repo and key commands
```

Background research runs in a detached PI child session with a headless-safe tool surface:

- safe read-only built-ins: `read`, `grep`, `find`, `ls`, `bash`
- native OpenAI/Codex `web_search` enabled by default on supported Responses models
- installed web research tools remain available as fallback or adjuncts when native web search is unavailable
- no mutation tools in the detached child

Current research boundary:

- Inline `/codex:research` runs in the current PI session.
- If you omit `--thinking`, inline and background research inherit the current PI session thinking level.
- Inline `/codex:research --thinking ...` temporarily changes the current PI session thinking level for that injected turn only. If the agent is already busy, use `--background` instead.
- Background `/codex:research --thinking ...` runs in a detached read-only worker and keeps the selected thinking level visible in launch, status, and result views.

All major `pi-codex` workflows accept `--thinking off|minimal|low|medium|high|xhigh`:

- `/codex:review`
- `/codex:adversarial-review`
- `/codex:adversarial_mental_models_review`
- `/codex:task`
- `/codex:research`

When omitted, `pi-codex` inherits the current PI session thinking level and clamps it to the selected model's capabilities.

Background jobs notify the originating PI session when they complete, fail, or are cancelled, so you can keep working in the main thread without polling.
Short results are inlined directly into the completion notification. Longer results show a short preview plus follow-up commands such as `/codex:result --last`, `/codex:result <job-id>`, or `/codex:apply <job-id>`.
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
