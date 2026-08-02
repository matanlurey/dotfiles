---
description: Review new comments left during the audit - investigate each and either file an issue or fix it locally.
deterministic:
  script: ./audit-scripts/audit.mjs
  args: ["pending-comments"]
  handoff: on-success
---
Each pending comment above has an `intent` (parsed from its own leading prefix - see the `hunk-audit` skill for the prefix syntax):

- **explain** - answer the question in `text` directly, referencing the actual code. Do not file or fix anything.
- **file** - investigate as usual, then file a cleanup issue regardless of how minor it seems.
- **fix** - investigate as usual, then make the fix locally (uncommitted) regardless of complexity.
- **auto** (no prefix) - investigate, then use your own judgment to file or fix.

Investigate before deciding anything, for every intent including file/fix - read the surrounding code, check history, check tests/usages. Don't act on the comment text alone. Read `~/.pi/agent/skills/hunk-audit/SKILL.md` for the full triage rules (investigation depth, when to use an isolated workspace, issue-filing conventions, the file-vs-fix default).

For each comment you resolve, call:

    node ~/.pi/agent/prompts/audit-scripts/audit.mjs mark-triaged <commentId> <filed|fixed|explained> --file <path> --line <n> --side <old|new> --note "<summary, or the full explanation for 'explained'>" [--issue <url>]
