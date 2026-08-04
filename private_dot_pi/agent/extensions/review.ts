/**
 * Code Review Extension
 *
 * /review              — self-review local changes (jj diff against main@origin)
 * /review <PR>         — review a GitHub PR (supports GHE)
 * /review <ref>        — review the diff against an arbitrary fixed point (branch, tag, commit)
 *
 * Runs two parallel sub-agent reviews of the diff:
 *   - Standards: does the code follow this repo's documented conventions + a fixed
 *     Fowler code-smell baseline?
 *   - Spec: does the code match the originating issue/PR/PRD, if one can be found?
 *
 * Each sub-agent reports using Conventional Comments format:
 *   <label> (<severity>): <subject>
 *   <discussion>
 *
 * Labels: bug, suggestion, question, nit, architecture, test, perf, praise, todo
 * Severity: blocking, non-blocking, if-minor
 *
 * Adapted from dmmulroy/.dotfiles' code-review skill
 * (https://github.com/dmmulroy/.dotfiles/blob/main/home/.agents/skills/code-review/SKILL.md),
 * merged with this repo's original /review command's local/PR diff resolution.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

const REVIEW_TAXONOMY = `
## Code Review Format (Conventional Comments)

When reviewing code, format every finding using Conventional Comments:

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

### Example

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
`;

// Fixed Fowler code-smell baseline (Refactoring, ch. 3) carried by the Standards axis
// regardless of what the repo documents. A documented repo standard always overrides
// the baseline where the two disagree; each smell below is a judgement call, never a
// hard violation.
const SMELL_BASELINE = `
## Standards axis: smell baseline

On top of whatever this repo documents (CODING_STANDARDS.md, CONTRIBUTING.md, AGENTS.md,
CLAUDE.md, etc.), always check the diff against this fixed baseline. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses
  something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature
  Envy"), never a hard violation — and, like any standard here, skip anything tooling
  already enforces (formatters, linters, type checkers).

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same switch/if-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long a.b().c().d() navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.
`;

interface DiffResult {
  diff: string;
  context: string;
  /** Human-readable description of what's being diffed, for spec/standards discovery instructions. */
  target: string;
}

function tryExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function localDiffAgainst(ref: string): DiffResult {
  // Prefer jj, fall back to git.
  const jjDiff = tryExec(`jj diff --from ${ref}`);
  if (jjDiff) {
    const log = tryExec("jj log --limit 5 --no-pager");
    return {
      diff: jjDiff,
      context: `Reviewing local changes (jj diff --from ${ref}).\n\nRecent history:\n${log}`,
      target: `local working copy vs ${ref}`,
    };
  }

  const gitDiff = tryExec(`git diff ${ref}...HEAD`);
  if (gitDiff) {
    const log = tryExec("git log --oneline -5");
    return {
      diff: gitDiff,
      context: `Reviewing local changes (git diff ${ref}...HEAD).\n\nRecent history:\n${log}`,
      target: `local HEAD vs ${ref}`,
    };
  }

  throw new Error(`No changes found between HEAD and ${ref}. Are you in a jj/git repo?`);
}

function getDiff(args: string): DiffResult {
  const trimmed = args.trim();

  if (!trimmed) {
    // Local self-review: diff against main@origin (jj) / origin/main (git)
    try {
      return localDiffAgainst("main@origin");
    } catch {
      return localDiffAgainst("origin/main");
    }
  }

  // PR review: URL, repo#123, or bare number
  const isPrUrl = trimmed.startsWith("http");
  const isRepoHash = trimmed.includes("#");
  const isBareNumber = /^\d+$/.test(trimmed);

  if (isPrUrl || isRepoHash || isBareNumber) {
    let repo = "";
    let prNumber = "";
    let ghHost = "";

    if (isPrUrl) {
      const match = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      if (!match) throw new Error(`Could not parse PR URL: ${trimmed}`);
      ghHost = match[1];
      repo = match[2];
      prNumber = match[3];
    } else if (isRepoHash) {
      const [r, n] = trimmed.split("#");
      repo = r;
      prNumber = n;
    } else {
      prNumber = trimmed;
      const remote = tryExec("git remote get-url origin");
      if (!remote) {
        throw new Error(
          "Could not infer repo from git remote. Use /review <owner/repo>#<number> or a URL."
        );
      }
      const httpsMatch = remote.match(/https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
      const sshMatch = remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        ghHost = httpsMatch[1];
        repo = httpsMatch[2];
      } else if (sshMatch) {
        repo = sshMatch[1];
        const hostMatch = remote.match(/@([^:]+):/);
        ghHost = hostMatch ? hostMatch[1] : "";
      } else {
        throw new Error(
          "Could not infer repo from git remote. Use /review <owner/repo>#<number> or a URL."
        );
      }
    }

    if (!ghHost) ghHost = "github.com";
    const env = ghHost !== "github.com" ? `GH_HOST=${ghHost} ` : "";

    const diff = execSync(`${env}gh pr diff ${prNumber} -R ${repo}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();

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
      target: `PR #${prNumber} on ${repo}`,
    };
  }

  // Otherwise: arbitrary fixed point (branch, tag, commit SHA) for a local diff
  return localDiffAgainst(trimmed);
}

export default function review(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n${REVIEW_TAXONOMY}`,
    };
  });

  pi.registerCommand("review", {
    description:
      "Two-axis review (Standards + Spec, parallel sub-agents) — /review for local changes (jj/git), /review <PR>, or /review <ref> for an arbitrary fixed point",
    handler: async (args, ctx) => {
      try {
        const { diff, context, target } = getDiff(args);

        const maxLen = 100_000;
        const truncated =
          diff.length > maxLen
            ? diff.slice(0, maxLen) + "\n\n... (diff truncated, review what's shown)"
            : diff;

        const prompt = `Review the following diff along two independent axes: **Standards** and **Spec**. Run both as parallel sub-agents (use the \`subagent\` tool's parallel tasks mode with the \`reviewer\` agent, one task per axis) so neither axis's context pollutes the other, then aggregate their reports yourself. Do not review the diff directly — delegate both axes.

${context}

Diff target: ${target}

\`\`\`diff
${truncated}
\`\`\`

### Standards sub-agent task
Give it: the diff above, any standards-source files you find in this repo (CODING_STANDARDS.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md, or similar — search for them first), and the smell baseline below verbatim (the sub-agent has no other access to it).

${SMELL_BASELINE}

Brief for the Standards sub-agent: "Report every place the diff violates a documented standard (cite the file + rule) and any baseline smell you spot (name it, quote the hunk). Use Conventional Comments format per finding (label + severity + discussion). A documented repo standard overrides the baseline. Skip anything tooling already enforces. Distinguish hard violations (documented-standard breaches) from judgement calls (baseline smells, always judgement calls). Include at least one praise comment if warranted."

### Spec sub-agent task
Before spawning it, look for the originating spec, in this order: (1) issue/PR references in commit messages or the PR body above (fetch via \`gh issue view\` / \`gh pr view\` if found), (2) a path the user passed as a second argument, (3) a PRD/spec file under docs/, specs/, or .scratch/ matching the branch name or feature. If nothing is found, skip the Spec sub-agent entirely and note "no spec available" in the final report instead of guessing.

If a spec is found, give the sub-agent: the diff above, and the fetched spec content. Brief: "Report using Conventional Comments format: (a) requirements the spec asked for that are missing or partial (bug/blocking or todo depending on scope), (b) behavior in the diff that wasn't asked for — scope creep (question or suggestion), (c) requirements that look implemented but wrong (bug). Quote the spec line for each finding."

### Aggregation
Present the two sub-agent reports verbatim (or lightly cleaned) under \`## Standards\` and \`## Spec\` headings. Do not merge or rerank findings across axes — a change can pass one axis and fail the other (e.g. follows every standard but implements the wrong thing, or vice versa); keeping them separate stops one axis from masking the other. End with a summary table of finding counts by label per axis, and the worst issue within each axis (if any) — don't pick one winner across both axes.`;

        pi.sendUserMessage(prompt);
      } catch (e: any) {
        ctx.ui.notify(e.message || "Review failed", "error");
      }
    },
  });
}
