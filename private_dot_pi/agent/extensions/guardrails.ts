/**
 * Bash command guardrails
 *
 * System-prompt nudges (CLI Preferences, AGENTS.md rules) don't reliably
 * stop weaker/faster models from running commands that hang the session or
 * violate stated policy. This hooks the `tool_call` event to hard-block a
 * small set of known-bad bash invocations before they execute, and tells
 * the model what to do instead.
 *
 * Blocked:
 * - `find` rooted at `/`, `~`, or `$HOME` with no narrowing — these can run
 *   for minutes over the whole filesystem and never return useful results.
 * - `jj`/`git` commands with `-i`/`--interactive` — these open an editor
 *   that hangs a non-interactive agent session forever.
 * - `jj squash` — AGENTS.md says never squash commits; this makes it a hard
 *   rule instead of a suggestion.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Split on shell operators so multi-command lines (`a && b`, `a; b`, pipes)
// are each checked independently.
function splitCommands(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function isUnboundedFind(cmd: string): string | undefined {
  const m = cmd.match(/^(?:sudo\s+)?find\s+(.*)$/);
  if (!m) return undefined;

  const rest = m[1];
  const firstArg = rest.trim().split(/\s+/)[0];

  const rootLike = new Set(["/", "~", "$HOME", "${HOME}"]);
  // Also catch absolute paths to obvious system-wide roots.
  const isSystemRoot = /^\/(Users|home)?\/?$/.test(firstArg);

  if (rootLike.has(firstArg) || isSystemRoot) {
    return `"find" starting at "${firstArg}" scans the whole filesystem and can run for minutes without returning. Use the built-in \`find\` tool (glob, scoped to a directory) or \`fd\` instead, e.g. \`fd "pattern" ~/some/dir\`.`;
  }
  return undefined;
}

function isInteractiveVcs(cmd: string): string | undefined {
  const m = cmd.match(/^(jj|git)\s+/);
  if (!m) return undefined;
  const tool = m[1];
  if (/\s(-i\b|--interactive\b)/.test(cmd)) {
    return `"${tool} ... ${cmd.includes("--interactive") ? "--interactive" : "-i"}" opens an editor/diff tool and hangs a non-interactive agent session. Use explicit flags instead (e.g. \`jj describe -m "..."\`, \`jj split <paths...>\`, \`jj new -m "..."\`).`;
  }
  return undefined;
}

function isJjSquash(cmd: string): string | undefined {
  if (/^jj\s+squash\b/.test(cmd)) {
    return `Squashing commits is disabled by policy (see AGENTS.md: "Never squash commits"). Start a new commit instead with \`jj new -m "message"\`, or if you must fold work into an existing draft commit, ask the user first.`;
  }
  return undefined;
}

export default function guardrails(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string }).command;
    if (!command) return;

    for (const cmd of splitCommands(command)) {
      const reason =
        isUnboundedFind(cmd) ?? isInteractiveVcs(cmd) ?? isJjSquash(cmd);
      if (reason) {
        return { block: true, reason };
      }
    }
  });
}
