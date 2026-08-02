# Working on gh-agent

Notes for whoever edits this extension next. README.md covers usage; this covers
how the thing is built, how to test it, and the mistakes that have already been
made here so they don't get made again.

## Shape

```
index.ts     control surface (/gh-agent commands) + the worker-mode bash guard
daemon.ts    poll loop: reconcile GitHub against local state, then step
worker.ts    git isolation, headless pi runs, the phase machine, status reporting
github.ts    App auth (JWT -> installation token) + the REST surface, no SDK
prompts.ts   phase prompts and the verdict contract
state.ts     per-issue records, atomic writes, pid locks, schema migration
config.ts    config, filesystem layout, validation
```

Only `index.ts` is loaded by pi (a directory extension loads its index and
nothing else). The daemon is a separate detached process, so work survives
closing the TUI.

## The two rules everything else follows from

**The harness owns every mutation.** The agent edits files. It does not run
git, does not touch the GitHub API, and has no credentials: `runPi` strips
`GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, and git's config/askpass from the
child environment, and `forbiddenForWorker` in index.ts blocks `gh` plus
mutating `git`/`jj` at the tool-call level. This is why "never auto-merge" and
"never force-push" are true by construction rather than by asking the model.

If the agent needs something on GitHub, it asks through the verdict and the
harness performs it. That is what `prTitle` and `replies` are for. Add new
fields the same way rather than handing the agent credentials.

**Every headless run must return a verdict.** A missing or malformed block
parses as confidence 0 and status `failed`, so a truncated or confused run
escalates instead of silently proceeding. `parseVerdict` also refuses to accept
an unknown `status` as `ok`, and takes the *last* block so a run that echoes the
contract earlier can't spoof it.

## Testing

There is no test runner here. Everything below is a `node /tmp/x.ts` script run
against the real thing, which has caught more than a mocked suite would.

**Typecheck against pi's actual types**, not a stub:

```
npx tsc --noEmit --strict \
  --paths '{"@earendil-works/pi-coding-agent":["<pi>/dist/index.d.ts"]}'
```

This caught `res.exitCode` (pi's `ExecResult` uses `code`).

**Node strips types, it does not compile them.** No enums, no namespaces, no
parameter properties, no decorators. Verify with `node <file>.ts`, which is how
the daemon actually runs.

**Use real git sandboxes for git logic.** Build a bare repo, push a diverging
branch, and drive the real functions. The worktree isolation and merge-conflict
paths were both verified this way, including asserting that `main`'s SHA is
byte-identical after a push and that the original commit survives a merge.

**Probe live APIs for capability before building on an assumption.**
`GET /repos/{repo}/assignees/{login}` answered "can a bot be assigned?" (no)
without side effects. Sending a deliberately wrong App ID proved the JWT was
well-formed and surfaced that `iss` must be a JSON integer.

**Verify guards from both directions.** The bash guard tests assert 10 blocked
commands and 11 allowed, including near-misses like `gharial --version` and
`legit push` that a sloppy regex would catch.

**Check what actually landed on GitHub**, not what the code intended. Reading
the PR timeline is what revealed `actor: matanlurey` on a rename the bot was
supposed to have done.

## Mistakes already made here

**Test with the flags the daemon really uses.** Early probes passed `-ne`, which
disables extensions, which disabled the Anthropic auth extension, which produced
a convincing "quota exhausted" error. Nothing was wrong. `runPi` passes no `-ne`.

**Escape backticks in prompt template literals.** `` `plan` `` inside a
template literal terminates the string. This has broken the build twice. When
adding prompt text with inline code, write `` \` ``.

**Never reuse `summary` for a human-facing surface.** It is the long internal
record, and it reads like one. This shipped three times: a 2.6k-character PR
body, a 2.5k-character plan comment, and a 1.4k-character review reply. Each
human-facing surface gets its own field with an explicit format and a word cap
enforced in `parseVerdict`, because the prompt alone will not hold the line.

**Migrate persisted state when adding a field.** JSON has no `undefined`, so a
record written before a field existed reads back as `undefined` and slips past
`!== null`. That produced `PATCH /issues/comments/undefined` on the first live
run. `migrate()` in state.ts normalizes every nullable and collection field;
extend it whenever `IssueState` grows.

**GitHub returns superseded check runs.** A check that failed and was re-run
appears twice for the same SHA. Dedupe by name, newest first, or a green PR
loops in CI-fixing forever.

**Kill process groups, not processes.** `SIGKILL` on the child leaves `cargo`
and `rustc` grandchildren holding the stdio pipes, so a 25 minute budget ran
34 minutes. Children spawn `detached` and the whole tree gets signalled.

## Things worth knowing

- A private GitHub App only installs on the account that owns it, so covering a
  user and an org needs one App each. Requests route by owner/repo in the path.
- Bots cannot be assigned to issues. Ownership is signalled with a mutually
  exclusive `agent:*` label and one status comment edited in place.
- `mergeable` is `null` while GitHub computes it. That is not the same as
  conflicted; skip the cycle.
- Merge, never rebase. Rebasing needs a force push, which orphans inline
  comments and resets reviewers' viewed markers.
- A phase that timed out retries on `escalationModel`, because rerunning the
  same prompt on the same model reproduces the same failure.
- Measured across 11 runs, successful phases have a median around 90s. Do not
  add speculative model downgrades without data; the runs that cost money are
  the ones that fail, and those want a stronger model.

## Manual verification loop

```
node ~/.pi/agent/extensions/gh-agent/daemon.ts --once   # one cycle, foreground
tail -f ~/.pi/agent/gh-agent-worker/logs/<repo>__<n>-*.log   # live run output
```

Set `dryRun: true` first. It suppresses GitHub writes and pushes but still runs
the model, so the plan and diff are real while nothing escapes.
