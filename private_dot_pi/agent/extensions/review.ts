/**
 * Code Review Extension
 *
 * /review         — self-review local changes (jj diff against main@origin)
 * /review <PR>    — review a GitHub PR (supports GHE)
 *
 * Uses Conventional Comments format:
 *   <label> (<severity>): <subject>
 *   <discussion>
 *
 * Labels: bug, suggestion, question, nit, architecture, test, perf, praise, todo
 * Severity: blocking, non-blocking, if-minor
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";



const REVIEW_TAXONOMY = `
## Code Review Format (Conventional Comments)

When reviewing code, format every comment using Conventional Comments:

\`\`\`
<label> (<severity>): <subject>

<discussion>
\`\`\`

### Labels
| Label | Use when |
|-------|----------|
| **bug** | Logic errors, deadlocks, race conditions, incorrect behavior |
| **suggestion** | Code improvements — always include a replacement snippet |
| **question** | Clarification needed — "Is this intentional?", "Why?" |
| **nit** | Typos, naming, style — always non-blocking |
| **architecture** | Design concerns — interface segregation, package structure, separation of concerns |
| **test** | Missing coverage, fragile mocks, fixtures in production code |
| **perf** | Algorithmic complexity, unnecessary allocations |
| **praise** | Positive feedback — find at least one thing to praise |
| **todo** | Defer to follow-up — explicitly mark as non-blocking |

### Severity (in parentheses after label)
| Severity | Meaning |
|----------|---------|
| **blocking** | Must fix before merge |
| **non-blocking** | Should fix, but don't hold the PR |
| **if-minor** | Fix only if the change is trivial |

**Nits are always non-blocking. Bugs default to blocking unless stated otherwise.**

### Example output

\`\`\`
bug (blocking): This goroutine can deadlock if no channel is found.

GetChannels is synchronous — the goroutine and channel are unnecessary.
Consider a simple for loop instead:

\\\`\\\`\\\`go
for {
    resp, err := client.GetChannels(ctx, req)
    if err != nil { return nil, err }
    for _, ch := range resp.Channels {
        if ch.Source.ExecutableId == id { return ch, nil }
    }
}
\\\`\\\`\\\`

---

praise: Clean test structure with table-driven cases.

---

nit (non-blocking): \`s/verion/version\`
\`\`\`

### Review structure
1. Start with a one-line summary of the change
2. List findings grouped by file, each as a Conventional Comment
3. End with a summary table: X bug(s), Y suggestion(s), Z nit(s), etc.
4. Include at least one praise comment per review
`;

function getDiff(args: string): { diff: string; context: string } {
  if (!args || args.trim() === "") {
    // Local self-review: jj diff against main@origin
    try {
      const diff = execSync("jj diff --from main@origin", {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      if (!diff) {
        throw new Error("No changes found between current revision and main@origin");
      }

      // Get jj log for context
      let log = "";
      try {
        log = execSync("jj log --limit 5 --no-pager", {
          encoding: "utf-8",
        }).trim();
      } catch {}

      return {
        diff,
        context: `Self-reviewing local changes (jj diff --from main@origin).\n\nRecent history:\n${log}`,
      };
    } catch (e: any) {
      // Fallback to git if jj isn't available
      try {
        const diff = execSync("git diff origin/main...HEAD", {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        }).trim();

        if (!diff) {
          throw new Error("No changes found between HEAD and origin/main");
        }

        return { diff, context: "Self-reviewing local changes (git diff origin/main...HEAD)." };
      } catch {
        throw new Error(
          e.message || "Failed to get diff. Are you in a jj/git repo with changes?"
        );
      }
    }
  }

  // PR review: parse PR number or URL
  const trimmed = args.trim();
  let repo = "";
  let prNumber = "";
  let ghHost = "";

  if (trimmed.startsWith("http")) {
    const match = trimmed.match(
      /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/
    );
    if (!match) throw new Error(`Could not parse PR URL: ${trimmed}`);
    ghHost = match[1];
    repo = match[2];
    prNumber = match[3];
  } else if (trimmed.includes("#")) {
    // repo#123 format
    const [r, n] = trimmed.split("#");
    repo = r;
    prNumber = n;
  } else if (/^\d+$/.test(trimmed)) {
    // Just a number — infer repo from current directory
    prNumber = trimmed;
    try {
      const remote = execSync("git remote get-url origin", {
        encoding: "utf-8",
      }).trim();
      // Parse git@host:owner/repo.git or https://host/owner/repo.git
      const sshMatch = remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
      const httpsMatch = remote.match(
        /https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/
      );
      if (httpsMatch) {
        ghHost = httpsMatch[1];
        repo = httpsMatch[2];
      } else if (sshMatch) {
        repo = sshMatch[1];
        // Infer host from SSH remote
        const hostMatch = remote.match(/@([^:]+):/);
        ghHost = hostMatch ? hostMatch[1] : "";
      }
    } catch {
      throw new Error(
        "Could not infer repo from git remote. Use /review <owner/repo>#<number> or a URL."
      );
    }
  } else {
    throw new Error(
      `Could not parse: ${trimmed}\nUsage: /review, /review 123, /review owner/repo#123, or /review <URL>`
    );
  }

  if (!ghHost) {
    ghHost = "github.com";
  }

  const env = ghHost !== "github.com" ? `GH_HOST=${ghHost} ` : "";

  // Fetch PR diff
  const diff = execSync(
    `${env}gh pr diff ${prNumber} -R ${repo}`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
  ).trim();

  // Fetch PR info
  let prInfo = "";
  try {
    prInfo = execSync(
      `${env}gh pr view ${prNumber} -R ${repo} --json title,body,author,baseRefName,headRefName --jq '"PR #" + (.number|tostring) + ": " + .title + "\\nAuthor: " + .author.login + "\\nBase: " + .baseRefName + " ← " + .headRefName + "\\n\\n" + (.body // "")'`,
      { encoding: "utf-8" }
    ).trim();
  } catch {}

  return {
    diff,
    context: `Reviewing PR #${prNumber} on ${repo} (${ghHost}).\n\n${prInfo}`,
  };
}

export default function review(pi: ExtensionAPI) {
  // Inject review taxonomy into system prompt
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n${REVIEW_TAXONOMY}`,
    };
  });

  // /review command
  pi.registerCommand("review", {
    description:
      "Review code — /review for local changes (jj), /review <PR> for a GitHub PR",
    handler: async (args, ctx) => {
      try {
        const { diff, context } = getDiff(args);

        // Truncate very large diffs
        const maxLen = 100_000;
        const truncated =
          diff.length > maxLen
            ? diff.slice(0, maxLen) + "\n\n... (diff truncated, review what's shown)"
            : diff;

        const prompt = `Review the following code changes using Conventional Comments format.

${context}

\`\`\`diff
${truncated}
\`\`\`

Review every file. Be thorough. Use the label/severity taxonomy from the system prompt. Include at least one praise comment.`;

        pi.sendUserMessage(prompt);
      } catch (e: any) {
        ctx.ui.notify(e.message || "Review failed", "error");
      }
    },
  });
}
