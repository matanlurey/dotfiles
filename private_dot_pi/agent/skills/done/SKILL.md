---
name: done
description: When we finish a feature. Use when the user says work is done, asks to merge a worktree back to main/master, or clean up a worktree.
---
Review remaining uncommitted code. If all changes are related and can fit into an atomic commit, create a single commit. If work should be broken into multiple atomic commits, do so and commit all.

If we're on a worktree, rebase onto main/master and resolve conflicts.

Then confirm whether to open a PR or merge into main directly.

If work on this feature was tied to a GitHub issue or taskboard ticket, mark that issue as completed if available tooling allows.

Finally, clean up the worktree.

## Version control: jj vs git

Check for a `.jj` directory first. If present, use `jj`; otherwise fall back to `git`.

### With jj

- Uncommitted changes are already part of the working copy; there's no staging step. Use `jj describe -m "message"` to describe the current change, or `jj new -m "message"` to start a fresh one before continuing work.
- To split unrelated changes into multiple atomic commits, use `jj split <FILESETS...>` with explicit paths (never interactive mode; it opens an editor and hangs in agent sessions).
- To land the feature, rebase it onto main/master: `jj rebase -r <change> -d main` (or `-d master`), resolving conflicts if any.
- Push with `jj git push`, not `git push`. Since jj rewrites commit SHAs on rebase/describe, this is effectively a force push — if the branch has an open PR with existing reviews, warn the user before pushing and prefer adding new commits on top (`jj new -m "..."`) instead of rewriting reviewed commits.
- Clean up a workspace (jj's equivalent of a worktree) with `jj workspace forget <name>` followed by `rm -rf` on its directory.
- Never use `-i`/`--interactive` or any command that opens `$EDITOR`; always pass `-m` explicitly.

### With git

- Stage and commit related changes together (`git add`, `git commit -m "..."`); split unrelated changes into separate commits.
- If on a worktree, rebase onto main/master and resolve conflicts, then `git push`.
- Remove a worktree with `git worktree remove <path>` once merged.
