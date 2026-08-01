# gh-agent

Watches a GitHub repo for issues labelled `good for agent`, works them autonomously in an isolated worktree, opens a pull request, answers review feedback, fixes red CI, and shuts down when the PR merges or the label is removed.

## How it works

A detached daemon polls GitHub on an interval. It never runs inside the pi TUI, so closing your session doesn't stop work in flight.

```
poll ──> reconcile ──> step (bounded concurrency)
          │
          ├── newly labelled issue      -> claim, create worktree + branch
          ├── label removed             -> close PR, delete branch, clean up
          ├── PR merged                 -> archive state, clean up
          ├── human answered a question -> unblock, resume
          ├── new review                -> phase: responding
          └── CI failed on a new SHA    -> phase: ci_fixing
```

Each issue moves through a phase machine:

| Phase | What happens |
|---|---|
| `claimed` | Worktree + branch created, ack comment posted |
| `planning` | Agent explores the repo and writes a plan. Posts it to the issue |
| `implementing` | Agent makes the change. Harness commits and pushes |
| `pr_open` | Draft PR opened, linked back to the issue |
| `awaiting_review` | Idle. Watching for reviews, comments, CI |
| `responding` | New commit addressing review feedback, plus a reply |
| `ci_fixing` | Diagnoses and fixes a failing pipeline |
| `blocked` | Posted a question, waiting on a human |
| `paused` | Hit a budget ceiling, needs a human to restart it |
| `done` / `abandoned` | Merged, or label removed |

### Checkpoints

Every headless run must end with a machine-readable verdict:

```
<<<AGENT_VERDICT>>>
{"confidence": 0.82, "status": "ok", "question": null, "summary": "..."}
<<<END_AGENT_VERDICT>>>
```

The daemon parses it and escalates rather than guessing. A missing or malformed block counts as zero confidence, so a truncated or confused run asks for help instead of opening a PR. Confidence thresholds: 0.6 to leave planning, 0.5 for the rest.

## Guardrails

These hold by construction, not by prompt instruction. The agent is told never to run git; the harness owns every mutation.

- Never auto-merges. A human always merges.
- Never pushes to a default branch. Work only ever lands on `agent/issue-<n>`.
- Never force-pushes or amends. Review rounds add commits on top, so reviewer "viewed" markers and inline comments survive.
- Hard wall-clock budget per phase (25 min). Exhaustion pauses the issue with a status comment.
- Bounded CI-fix attempts and review rounds. Exceeding either pauses rather than looping.
- Repo access is bounded by the GitHub App installation, plus an optional `repos` allowlist.
- Dry-run mode plans and logs without commenting, pushing, or opening PRs.

The agent is also told not to weaken tests or edit CI config to force a green pipeline, and to escalate on unrelated/flaky failures instead.

## Setup

### 1. Create the GitHub App

At github.com/settings/apps/new:

- Webhook: **uncheck Active** (this polls; no public endpoint needed)
- Repository permissions:
  - Contents: Read & write
  - Issues: Read & write
  - Pull requests: Read & write
  - Checks: Read-only
  - Actions: Read-only (for failing job logs)
  - Metadata: Read-only (automatic)
- Where can this be installed: Only on this account

Generate a private key, then save it as `~/.pi/agent/gh-agent-worker/private-key.pem` with mode `600`. The daemon refuses to start if the key is group- or world-readable.

Install the App and grant it only the repos it should touch. That installation is the real allowlist, enforced by GitHub rather than by this code.

### 2. Configure

```
/gh-agent setup
```

Prompts for the App ID (top of the App settings page), the label, a repo allowlist, concurrency, and whether to start in dry run. Writes `~/.pi/agent/gh-agent-worker/config.json`.

### 3. Protect the default branch

On each repo, require a PR and a review to merge. That makes "never push to main" a GitHub-enforced rule rather than a promise from this extension.

### 4. Run

```
/gh-agent once     # single cycle, foreground, good for a first test
/gh-agent start    # detached daemon
/gh-agent status   # what everything is doing
/gh-agent logs 60  # tail the daemon log
/gh-agent stop
```

Start with `dryRun: true`, label one small issue, and read the log before letting it write anything.

## Config

`~/.pi/agent/gh-agent-worker/config.json`:

```json
{
  "appId": "1234567",
  "privateKeyPath": "~/.pi/agent/gh-agent-worker/private-key.pem",
  "label": "good for agent",
  "pollIntervalSeconds": 60,
  "maxConcurrentIssues": 3,
  "repos": ["owner/name"],
  "model": "anthropic/claude-sonnet-5",
  "thinking": "medium",
  "budget": {
    "maxTurnsPerPhase": 40,
    "maxCiFixAttempts": 3,
    "maxReviewRounds": 10,
    "maxUsdPerIssue": 5
  },
  "dryRun": false,
  "branchPrefix": "agent/"
}
```

Empty `repos` means every repo the App installation can see.

## Layout

Code is version controlled here. Runtime data is not, so no secret is ever tracked.

```
~/.pi/agent/gh-agent-worker/
├── config.json          # 600
├── private-key.pem      # 600, never in git
├── token-cache.json     # installation token, refreshed hourly
├── daemon.pid
├── state/               # one JSON per issue, plus .lock files
│   └── archive/
├── repos/               # one cached clone per repo
├── worktrees/           # one worktree per in-flight issue
└── logs/                # daemon.log, per-run transcripts, pi sessions
```

State files are a cache and a lock, not the source of truth. Delete one and the daemon rebuilds it from the issue and PR. Writes are atomic, and locks record a pid so a crashed daemon's locks get reclaimed.

Each issue gets a stable pi session id, so planning, implementation, review responses, and CI fixes share one conversation and the agent remembers its own earlier reasoning.

## Notes

- Commits and PRs are attributed to `matanlurey-agent[bot]`, not to you. Installation tokens double as git credentials via `x-access-token`.
- Target repos are cloned fresh, so git worktrees are used rather than jj workspaces.
- Headless runs use `-a` to trust project-local `AGENTS.md` / `CLAUDE.md`, so the agent follows each repo's conventions. Only grant the App repos you're willing to have it read that way.
- `maxUsdPerIssue` and `maxTurnsPerPhase` are recorded in config but not yet enforced; the wall-clock phase timeout and the CI/review round caps are the budget mechanisms that actually bite today.
