---
name: hunk-audit
description: Triage comments left during a manual Hunk code audit - investigate each one, then file a cleanup issue or fix it locally. Use when running /audit-triage, or when asked to process/triage Hunk audit comments.
---

# Hunk Audit - Triage

This skill covers the judgment part of the `/audit` workflow: what to do with
each comment a human left while manually reviewing batches in Hunk. The
mechanical parts (batching, progress, resuming) are handled by
`~/.pi/agent/prompts/audit-scripts/audit.mjs` and the `/audit`, `/audit-next`,
`/audit-status`, `/audit-triage` commands - this file is about the triage
decision itself.

## The workflow this fits into

1. `/audit <path-or-glob>` batches all non-ignored, non-generated, non-binary
   files under that path and opens batch 1 in your live Hunk session.
2. You review manually, leaving comments in Hunk as you normally would.
3. `/audit-next` marks the batch reviewed and opens the next one.
4. `/audit-triage` (this skill) reads your comments since the last triage and
   resolves each one.

## Comment prefixes

A comment can start with one of these (colon optional - `fix: leaks the handle`,
`fix leaks the handle`, and bare `fix` are all valid) to skip the judgment call:

| Prefix | Outcome |
|--------|---------|
| `explain` | Answer the question directly - no issue, no fix |
| `file` | Always file a cleanup issue, however minor |
| `fix` | Always fix locally, however involved |
| *(none)* | `auto` - investigate, then use judgment (see below) |

`pending-comments` parses this and reports it as `intent` per comment - use
that field rather than re-parsing the raw text. `file`/`fix` still get the
full investigation below; only the outcome is forced instead of judged.
`explain` needs enough investigation to answer well, but never escalates to
an isolated workspace, filing, or fixing.

For `explain`, put the actual answer in `--note` when calling `mark-triaged`
with status `explained` - that's what shows up as the companion comment.
Also say it directly in chat; the person may not reopen Hunk right away.

## Always investigate before acting

Never transcribe a comment straight into an issue on faith. Minimum bar for
every comment, even ones you'll resolve quickly:

- Read the surrounding hunk/file for context the comment doesn't spell out.
- Check history (`jj log`/`jj file annotate` or `git log`/`git blame`) for why
  the code is the way it is - it may be intentional.
- Check for usages/tests elsewhere in the repo before assuming something is
  dead, unused, or safe to change.

This gives you standing to disagree, not just an opinion. If the investigation
shows the comment doesn't hold up, say so when you report back rather than
filing or fixing something you don't believe.

## When to escalate to an isolated workspace

Most investigation above is read-only and safe to do directly against the
live checkout. Escalate to a disposable workspace only when verifying the
claim requires actually running or mutating something - e.g. "is this really
dead code" warrants trying a removal and running the build/tests to see what
breaks.

Self-isolate explicitly rather than relying on a framework flag:

```bash
jj workspace add /tmp/hunk-audit-<short-slug>
```

per this machine's own convention (see the top-level AGENTS.md), not the
`subagent` tool's `worktree: true` option. That option is git-worktree-based,
and there are multiple open upstream issues where subagent worktree isolation
leaks writes or git-HEAD changes back into the parent checkout. Do the
experiment in the jj workspace, read the result, then clean up regardless of
outcome:

```bash
jj workspace forget <name> && rm -rf /tmp/hunk-audit-<short-slug>
```

## Decide: file an issue, or fix it locally (intent: auto only)

When a comment has no prefix (`intent: auto`), default to your own judgment:
fix small, mechanical, low-risk changes directly; file an issue for anything
that's a design question, touches multiple files/owners, or carries real
risk. This default is overridable - if the person running the audit says
"file everything" or "just fix what you can" (in chat, before or after
`/audit-triage`), follow that instead of judging each `auto` comment
individually for the rest of the session. Comments with an explicit `file`
or `fix` prefix always take that prefix's outcome regardless of this default.

**Fixing locally**: make the edit and leave it uncommitted. Do not run
`jj new` / `git commit` - the person doing the audit reviews and commits it
themselves. Say what changed and where.

**Filing an issue**:
- Check for an existing/duplicate issue first: `gh issue list --search "..."`.
- Detect the right host from the remote (`git remote get-url origin`); use
  `GH_HOST=<host> gh issue create` for anything not on github.com.
- Link back to the exact file and line (a permalink using the current commit
  SHA), and attribute the original observation to the human's comment -
  the issue body should distinguish "what was flagged" from "what I found."
- Creating new issues here is fine, it's what was asked for. Per this
  machine's AGENTS.md, still never comment on or reply to *existing*
  issues/PRs unless explicitly asked - that rule is unaffected by this skill.

## Always record the outcome

Whichever way a comment resolves, call `mark-triaged` so it isn't
reprocessed and so the outcome is visible back in Hunk at the same spot:

```bash
node ~/.pi/agent/prompts/audit-scripts/audit.mjs mark-triaged <commentId> <filed|fixed> \
  --file <path> --line <n> --side <old|new> --note "<short summary>" [--issue <url>]
```
