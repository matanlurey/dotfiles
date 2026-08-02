---
description: Mark the current audit batch reviewed and open the next one in Hunk.
deterministic:
  script:
    path: ./audit-scripts/audit.mjs
    args: ["next"]
  handoff: never
---
