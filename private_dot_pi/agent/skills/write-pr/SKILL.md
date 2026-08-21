---
name: write-pr
description: Write a short, non-slop PR title and description for the current branch or a named PR. Explains what the diff cannot show — the why, the behavioral change, the context — without listing files changed. Use when asked to draft, write, or improve a PR description.
---

# Write PR

The diff is already on GitHub. The description exists to explain what the diff cannot show: what was broken and now works, what was impossible and is now possible, what shape changed. Cut any sentence the reviewer could reconstruct from the diff itself.

**Never list files changed. Never include diffstat numbers, line counts, or file counts. Never name internal functions, mutexes, packages, or runtime primitives.**

## Workflow

1. Detect the VCS and gather the diff and commit log:

   **jj repo** (`.jj` directory present — check with `test -d .jj`):
   ```bash
   jj log --limit 15          # recent change history
   jj diff                    # diff of the current working-copy change (@)
   ```
   For a stack of changes, diff the whole branch against trunk:
   ```bash
   TRUNK=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   jj diff -r "trunk()..@"   # everything above the remote trunk
   jj log -r "trunk()..@" --no-graph
   ```
   Don't use `git diff origin/$BASE...HEAD` in a jj repo — jj doesn't update git branch refs the same way and you'll get an empty diff.

   **git repo** (no `.jj` directory):
   ```bash
   BASE=$(git rev-parse --abbrev-ref origin/HEAD | sed 's|origin/||' 2>/dev/null \
     || gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   git fetch --no-tags origin "$BASE"
   git log --oneline "origin/$BASE..HEAD"
   git diff "origin/$BASE...HEAD"
   ```

   For a named PR (either VCS): `gh pr view <ref> --json baseRefName,body` then `gh pr diff <ref>`.

2. Read the branch/bookmark name and any linked issue for context clues on the ticket/intent.

3. Draft title and body inline. **Show the draft before touching git.** Ask if the user wants to emphasize, omit, or reframe anything — they know what matters to their reviewers. Skip this only if they explicitly said "just write it."

4. After the user confirms, push and open the PR:

   ```bash
   git push origin HEAD
   # Write body to a file — never inline with --body; backticks expand inside double-quotes
   cat > /tmp/pr-body.md << 'BODYEOF'
   <body here>
   BODYEOF
   gh pr create --title '<title>' --body-file /tmp/pr-body.md
   ```

   Or update an existing PR: `gh pr edit <ref> --title '<title>' --body-file /tmp/pr-body.md`

   For code.vastspace.com repos: prefix every `gh` call with `GH_HOST=code.vastspace.com`.

## Structure

Use only the sections that add value. Omit empty ones.

```markdown
## What

<One standalone sentence: what the PR does in plain terms. Impact or outcome, not mechanism.>

<For larger PRs: bullet list of concrete behavioral changes. Each bullet = a user-visible outcome.>

## Why

<Scenario-driven. Who experiences what, and why it mattered enough to fix. No implementation details.>

## Note

<Optional. Migration steps, caveats, known limitations, anything reviewers need before they start.>

## Related

Closes #NNN
Related: #NNN
```

## Title

### code.vastspace.com repos

Repos on code.vastspace.com that use `branch-name-check` enforce specific formats. Check for it: `GH_HOST=code.vastspace.com gh api /repos/{owner}/{repo}/contents/.branch-name-check 2>/dev/null`.

**Branch name** must match:
```
^(feat(ure)?|(hot|rel)?fix(\(\d+\.\d+\))?|release|chore|ci|docs?|refactor|perf|test|build|style|revert)/[A-Za-z]{1,9}-[0-9]{1,6}-.*
```
Examples: `fix/SINE-121-broken-datepicker`, `feat/FSW-123-add-new-feature`, `chore/DVOP-101-update-deps`

**PR title** must match:
```
^(Revert ")?\[?[A-Z]{1,9}-[0-9]{1,6}\]?: .+
```
Examples: `FSW-123: Add new BIT feature`, `[DVOP-789]: Add PR title validation`

The ticket prefix (e.g. SINE, FSW, GNC, MOPS, DVOP, DOCS, PC) comes from the team's Jira project. If you don't know the ticket ID, ask before pushing.

### Everything else

Format: `type(scope): description` — conventional commits style.

- Types: `fix`, `feat`, `refactor`, `chore`, `docs`, `perf`, `test`, `ci`
- `fix` when adding code to remedy broken or missing behavior. `feat` only for capabilities the user could not previously do.
- Scope: narrowest useful label (component, area). Omit when nothing adds clarity.
- Description: imperative, lowercase, under 72 chars, no trailing period.
- Match conventions visible in recent commits: `git log --oneline -10 origin/$BASE`.
- Name the root cause, not the symptom and not the mechanism.
  - Symptom (what the user sees): "nil response on navigation"
  - Mechanism (how the bug happens): "race between nav and network events"
  - Root cause (what the code gets wrong): "frame document ordering"
  - Good: `browser: fix frame document ordering`
  - Bad: `browser: fix nil response on navigation` — symptom
  - Bad: `browser: fix race between navigation and network events` — mechanism

## Writing rules

### What section

- First sentence must describe impact or outcome, not mechanism. If it reads like a code comment ("defers X until after Y", "wraps the call in a retry"), zoom out until it describes what the user gets.
- No function names, package names, method names, or API calls. If you name a type, ask whether a product manager would know what it means.
- For bugfixes with user-visible symptoms (UI, CLI output, workflow): open with what the user saw before and what they see now. Then mention the technical cause only if it helps the reviewer understand risk.
- For larger PRs, follow the opening sentence with bullets. Each bullet = observable behavior, not an implementation step.

### Why section

- Paint the scenario: what the user does, what happens, why it's bad. A reader with no codebase knowledge should follow it.
- Lead with the broad impact (who benefits and how), then optionally narrow to the specific trigger that made this visible.
- No locks, goroutines, channels, error codes, data structures, or signal names.
- Don't badmouth the old approach. Describe what the new one enables.
- "X without Y" beats "X. No Y. No Z."
- One connected paragraph reads better than three choppy ones when context and problem are related.

### Sizing

Match description weight to change weight.

| Change | Approach |
|---|---|
| Trivial (typo, dep bump, config) | 1–2 sentences, no headers |
| Small bugfix or behavioral change | 3–5 sentences, headers only if two distinct concerns |
| Medium feature or refactor | Narrative opening, bullets for discrete gains, Note for anything reviewers need upfront |
| Large or architectural | Summary sentence + bullet list in What, scenario + gains in Why, Note for design decisions |
| Performance | Before/after measurements as a markdown table |

For small trivial PRs, the single outcome sentence is the entire body.

### Formatting

- Do not hard-wrap paragraphs. GitHub renders a single newline as `<br>`. Keep each paragraph on one physical line and let it soft-wrap.
- Use backticks on filenames, commands, branch names, and technical identifiers.
- Issue references as plain `#NNN` (no backticks — GitHub won't auto-link inside code spans).
- Cross-repo references need the full prefix: `org/repo#NNN`.
- Only add a diagram when the interaction is genuinely hard to explain in prose (multi-party flow, complex state machine). Two sentences that explain it mean no diagram.

### Anti-slop checklist

Before showing the draft, reject any sentence that:

- Lists files changed or restates the diff ("Adds `foo.ts`, modifies `bar.go`, updates tests")
- Names a function, struct, mutex, goroutine, channel, or package in the description
- Uses passive voice ("is now fetched", "was broken by")
- Refers to the PR itself ("this PR", "this change", "this adds")
- Uses an em dash as a connector ("X — Y") — split into two sentences instead
- Opens with the mechanism ("Defers response reads until after...") instead of the outcome
- Uses marketing adjectives (robust, seamless, powerful, elegant)
- Pads with filler ("it's worth noting", "simply", "in order to")

## Examples (study tone, not sentences)

### Trivial: no headers

**Title:** `config: move validation out of experimental`

```
Moves config validation into the stable package so the canonical implementation lives in the right module.

Related: #312
```

### Small bugfix: scenario Why

**Title:** `worker: unblock concurrent job creation`

```
## What

Concurrent job creation no longer blocks behind a slow download on the same node.

## Why

When a job uses a custom binary (e.g. with plugins), the worker downloads it during setup. That download can take minutes. While it runs, every other job on the same node waits, even though the downloads are independent.
```

No locks, mutexes, or goroutines mentioned. The reader understands when (custom binary download), what breaks (other jobs wait), and why it matters (unrelated work is serialized).

### Small bugfix: user-visible before/after

**Title:** `api: return accurate error on empty name lookup`

```
## What

Returns "not found" instead of "an error occurred communicating with the server" when the query returns no results.

## Why

The API responded correctly, but the resource wasn't there. The old message pointed users toward network issues when nothing was wrong.
```

### Medium: behavioral change with Note

**Title:** `cli: shell completions for plugin subcommands`

```
## What

Shell completions work for auto-provisioned plugin subcommands.

```bash
$ mycli plugin docs <TAB>
http  grpc  websockets  mqtt
```

## Why

Tab completion silently returned nothing for plugins that aren't compiled into the binary. Users who rely on auto-provisioning got no completions even though the plugin supports them when bundled.

## Note

Partial names and registered plugins are unaffected — Cobra handles those natively.
```

### Large: summary + bullets

**Title:** `docs: always-current documentation, smaller binary`

```
## What

Adds on-demand documentation loading with auto-refresh and preloading.

- Lazy-loads docs on demand instead of embedding all versions at build time.
- Automatically refreshes when docs change (ETag support).
- Adds `-preload` to download all versions at startup.

## Why

Stale docs produce wrong suggestions and outdated API usage. Docs now stay fresh without rebuilding or redeploying. The binary drops the 5MB embed; startup loads only the requested version instead of all 16K sections.

## Note

The filesystem abstraction used internally lets docs still be embedded at build time and refreshed at runtime. `-preload` offers the same benefit more explicitly.
```
