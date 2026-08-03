---
description: Deep-dive review of a path — reads every file, checks real callers/tests/conventions/asymmetries, reports as Conventional Comments
argument-hint: "<path> [extra focus]"
---
Deep dive into @$1 and see if we need any other changes, or there are obvious things missing, bugs, gaps, etc.

Do this before reporting back:
1. Read every file in the path (entry point/index first for structure, then each submodule/file).
2. Check what actually calls into this code elsewhere in the repo (grep for its public names/exports) — flag anything exported but never used by any real caller, consumer, or example.
3. Check test coverage: are edge cases (empty/zero/null, boundary values, re-entry or retry paths, combined features interacting with each other, error paths) actually asserted, not just the happy path?
4. Cross-check against project conventions (README/CONTRIBUTING/style guide/lint config if present): doc/comment quality, and run the project's lint/type-check/test command scoped to this path if one exists.
5. Look for asymmetries: one variant/case/branch handled differently from its siblings without a documented reason, or a feature that exists in one form (e.g. sync) but not its counterpart (e.g. async), if the codebase's pattern suggests it should.

Report using Conventional Comments (bug/suggestion/question/nit/architecture/test/perf/todo, with severity), grouped by file, ending with a summary count table. Prefer flagging real gaps (missing accessor, missing test, dead public API, undocumented interaction between two features) over style bikeshedding.

Extra focus for this pass, if any: ${@:2}
