---
description: Page through a path/glob in Hunk, batched - opens batch 1 (or resumes where you left off) in a live Hunk session.
---
Run this via bash now, then report its output verbatim - nothing else, no summarizing, no extra commentary:

    node ~/.pi/agent/prompts/audit-scripts/audit.mjs init "$1" ${@:2}

If it fails because no Hunk session is open for this repo, or because multiple sessions match and it's asking for `--session <id>`, tell me exactly what it needs and stop there. Don't try to launch Hunk yourself - that has to be a real terminal I've opened.
