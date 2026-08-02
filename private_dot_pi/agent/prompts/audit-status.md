---
description: Show audit progress (batches done/total, %) without changing anything.
deterministic:
  script: ./audit-scripts/audit.mjs
  args: ["status"]
  handoff: never
---
