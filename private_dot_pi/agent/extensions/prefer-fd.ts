/**
 * Prefer fd over find
 *
 * Nudges the agent to use `fd` instead of `find` for file searching,
 * since fd is faster, respects .gitignore, and has simpler syntax.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function preferFd(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}

## CLI Preferences

- Prefer \`fd\` over \`find\` for file searching. It's faster, respects .gitignore, and has simpler syntax.
  - Example: \`fd "pattern"\` instead of \`find . -name "pattern"\`
  - Example: \`fd -e ts\` instead of \`find . -name "*.ts"\`
`,
    };
  });
}
