---
description: Mark the current audit batch reviewed and open the next one in Hunk.
deterministic:
  script: ./audit-scripts/audit.mjs
  args: ["next"]
  handoff: never
---
