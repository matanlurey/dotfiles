/**
 * Prompts for each phase, plus the machine-readable verdict contract.
 *
 * Every headless run must end with a VERDICT block. The worker parses it to
 * decide whether to advance, ask the human a question, or stop. A run that
 * omits the block is treated as low confidence rather than as success, so a
 * confused or truncated run escalates instead of silently opening a PR.
 */

import type { CheckSummary, Issue, Review, ReviewComment } from "./github.ts";

export const VERDICT_START = "<<<AGENT_VERDICT>>>";
export const VERDICT_END = "<<<END_AGENT_VERDICT>>>";

export type Verdict = {
  /** 0..1 self-assessment. Below the phase threshold escalates to a human. */
  confidence: number;
  status: "ok" | "needs_help" | "failed";
  /** Question to post on the issue when status is needs_help. */
  question: string | null;
  /** Short human-readable summary, used in issue comments and PR bodies. */
  summary: string;
  /**
   * Proposed pull request title. The agent cannot touch GitHub itself, so this
   * is how it asks for a title matching the repo's convention (many repos gate
   * CI on a Conventional Commits PR title).
   */
  prTitle: string | null;
  /**
   * Reviewer-facing PR body. Deliberately separate from `summary`, which is an
   * internal record and runs long. Kept short on purpose: the diff already
   * shows what changed, so the body only needs to carry why.
   */
  prBody: string | null;
  /**
   * Skimmable plan posted on the issue before work starts.
   *
   * Separate from `summary` for the same reason as `prBody`: the internal
   * record is long prose, and nobody wants to read that on an issue.
   */
  plan: string | null;
  /**
   * Per-comment answers, posted as inline replies in the reviewer's own thread
   * rather than as one detached comment on the pull request.
   */
  replies: { commentId: number; body: string }[];
};

const VERDICT_CONTRACT = `
## Required output contract

End your final message with exactly this block, and nothing after it:

${VERDICT_START}
{"confidence": <0.0-1.0>, "status": "ok" | "needs_help" | "failed", "question": <string or null>, "prTitle": <string or null>, "prBody": <string or null>, "plan": <string or null>, "replies": [{"commentId": <number>, "body": "<short>"}], "summary": "<one paragraph>"}
${VERDICT_END}

Rules for the verdict:
- confidence is your honest probability that this phase's work is correct and complete. Do not inflate it.
- status "needs_help" means a human must answer something before you can proceed correctly. Set question to the exact question to post on the issue. Ask about intent, requirements, or tradeoffs. Never ask a question you can answer yourself by reading the repo.
- status "failed" means you could not do the work at all. Explain why in summary.
- prTitle proposes the pull request title. Check whether the repo enforces a title convention (a Conventional Commits CI check, CONTRIBUTING.md, or the style of recent merged PRs and CHANGELOG entries) and match it, including any breaking-change marker. Leave it null if you have no better title than the issue title.
- prBody is what a reviewer reads. Keep it under 120 words. The diff already shows what changed, so do not narrate it: no file-by-file walkthrough, no restating the issue, no summary of your own process. Lead with why the change is shaped the way it is, then note anything genuinely non-obvious (a tradeoff you made, a risk, something you deliberately left out), then say what you want looked at most closely. Omit any section you have nothing real to put in it. Plain prose or a couple of short bullets. No headings, no tables, no emoji.
- summary is the internal record and can be as long as it needs to be. Do not put that text in prBody or plan.
- Never fabricate progress. If you did not finish, say so.`;

const HOUSE_RULES = `
## Operating rules

- You are working autonomously on a GitHub issue. No human is watching this run.
- You have no GitHub credentials, by design. \`gh\` will not work, and neither will pushing. Every GitHub action is performed for you by the harness, as a bot user. To influence a pull request, use your verdict (summary becomes the PR body, prTitle becomes its title).
- Follow the repository's own conventions. Read AGENTS.md / CLAUDE.md / CONTRIBUTING.md if present and obey them.
- Match the surrounding code style. Do not reformat unrelated code.
- Do not touch CI config, release tooling, dependency pins, or secrets unless the issue explicitly asks.
- Do not create, amend, or push git commits yourself, and never run destructive git commands (reset --hard, push --force, branch -D). The harness handles all git operations.
- If tests exist, run them. If a test command is documented, use it.
- Prefer the smallest change that fully solves the issue.`;

function issueContext(issue: Issue, thread: string): string {
  return `## Issue #${issue.number}: ${issue.title}

Reported by @${issue.user.login}
${issue.html_url}

${issue.body?.trim() || "(no description)"}

${thread ? `## Discussion so far\n\n${thread}` : ""}`;
}

export function planningPrompt(issue: Issue, thread: string): string {
  return `You are picking up a GitHub issue labelled for autonomous work. This is the planning phase: understand the request and the codebase, then write a concrete plan. Do not modify any files yet.

${issueContext(issue, thread)}

## Your task

1. Explore the repository enough to know exactly where the change belongs.
2. Decide whether the issue is well specified. If it is ambiguous in a way that would change what you build, that is a needs_help verdict with a specific question.
3. Fill in \`plan\`. This is posted on the issue for a human to skim in about fifteen seconds, so format it as markdown exactly like this:

\`\`\`
- \`path/to/file.rs\` - what changes there, in one line
- \`path/to/other.rs\` - likewise

**Not doing:** anything you are deliberately leaving out, and why. Omit this line if there is nothing.

**Verify:** the exact commands you will run.
\`\`\`

Rules for plan: under 120 words. One bullet per file. No preamble, no restating the issue, no narrating your exploration, no paragraphs of prose. If a decision needs explaining, one short sentence after the bullets.

Put your longer reasoning in summary instead, where it stays out of the issue thread.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

export function implementPrompt(issue: Issue, plan: string): string {
  return `Implement the plan for issue #${issue.number}. You are on a clean branch in a dedicated worktree; edit files directly.

## Issue

${issue.title}

${issue.body?.trim() || "(no description)"}

## Approved plan

${plan}

## Your task

Make the change. Run the project's tests or build if they exist. Leave the working tree with your finished edits; the harness commits and pushes.

In summary, describe what you changed and what you verified, in a form suitable for a pull request body.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

export function reviewResponsePrompt(
  issue: Issue,
  reviews: Review[],
  comments: ReviewComment[],
): string {
  const ids = comments.map((c) => c.id);
  const reviewText = reviews
    .filter((r) => r.body?.trim())
    .map((r) => `### Review from @${r.user.login} (${r.state})\n\n${r.body}`)
    .join("\n\n");

  const inline = comments
    .map(
      (c) =>
        `### @${c.user.login} on ${c.path}${c.line ? `:${c.line}` : ""} (comment ${c.id})\n\n${c.body}`,
    )
    .join("\n\n");

  return `A human reviewed your pull request for issue #${issue.number}. Address their feedback.

${reviewText ? `## Review summaries\n\n${reviewText}` : ""}

${inline ? `## Inline comments\n\n${inline}` : ""}

## Your task

1. Address every point. If you disagree with a point, implement nothing for it and say so plainly rather than silently ignoring it.
2. Make the edits in the working tree. The harness commits them as a new commit on top, so reviewers keep their context. Never amend or force-push.
3. Fill in \`replies\`: one entry per inline comment above, using its exact comment id${ids.length ? ` (${ids.join(", ")})` : ""}. Each reply is posted directly into that reviewer's thread, so write it as a direct answer to that one comment.

Rules for each reply body: at most three sentences. Say what you changed, or that you disagree and why, in the first sentence. No preamble, no thanking, no restating their comment back at them, no summarizing the whole PR. If they asked a question, answer it directly.

Put your longer reasoning in summary, which is internal and is not posted anywhere.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

export function ciFixPrompt(issue: Issue, checks: CheckSummary, logs: string): string {
  return `CI is failing on your pull request for issue #${issue.number}. Fix it.

## Failing checks

${checks.failing.map((f) => `- ${f.name}: ${f.url}`).join("\n")}

${logs ? `## Failure output\n\n\`\`\`\n${logs.slice(0, 15000)}\n\`\`\`` : ""}

## Your task

Diagnose the failure and fix the underlying cause. Do not disable, skip, or weaken tests to make the pipeline green. Do not touch CI configuration to work around a real failure.

If the failure is unrelated to your change (a flake or a pre-existing break on the base branch), say so with status needs_help rather than papering over it.

In summary, explain the root cause and the fix.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

export function conflictPrompt(
  issue: Issue,
  baseBranch: string,
  conflicted: string[],
  diffContext: string,
): string {
  return `Your pull request for issue #${issue.number} conflicts with \`${baseBranch}\`. The harness has already started a merge, and these files are left with conflict markers for you to resolve.

## Conflicted files

${conflicted.map((f) => `- ${f}`).join("\n")}

${diffContext ? `## What changed on ${baseBranch}\n\n\`\`\`\n${diffContext.slice(0, 8000)}\n\`\`\`` : ""}

## Your task

Resolve every conflict by editing the files. Remove all conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).

Keep both sides' intent. The other side is work that already landed on ${baseBranch}, so do not discard it to make your change apply cleanly, and do not discard your change either. If the two are genuinely incompatible, that is a needs_help verdict explaining the incompatibility.

Do not run any git command. The harness completes the merge commit once you are done. Re-run the project's build or tests afterwards to confirm the resolution actually compiles.

In summary, say how you resolved each conflict.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

export function questionAnswerPrompt(issue: Issue, thread: string, answer: string): string {
  return `You previously asked a question on issue #${issue.number} and a human has answered. Resume work.

${issueContext(issue, thread)}

## The answer you were waiting for

${answer}

## Your task

Incorporate the answer and continue. If the answer fully unblocks you, proceed with the work in the working tree. If it raises a new blocking ambiguity, ask once more with status needs_help.

In summary, describe what you did with the answer.
${HOUSE_RULES}
${VERDICT_CONTRACT}`;
}

/**
 * Extract the verdict block. A missing or malformed block is deliberately
 * reported as low confidence so the caller escalates instead of proceeding.
 */
export function parseVerdict(output: string): Verdict {
  const start = output.lastIndexOf(VERDICT_START);
  const end = output.lastIndexOf(VERDICT_END);
  if (start === -1 || end === -1 || end < start) {
    return {
      confidence: 0,
      status: "failed",
      question: null,
      prTitle: null,
      prBody: null,
      plan: null,
      replies: [],
      summary: "The run produced no verdict block, so its result cannot be trusted.",
    };
  }
  const json = output.slice(start + VERDICT_START.length, end).trim();
  try {
    const parsed = JSON.parse(json) as Partial<Verdict>;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    return {
      confidence: Math.max(0, Math.min(1, confidence)),
      status: parsed.status === "ok" || parsed.status === "needs_help" ? parsed.status : "failed",
      question: typeof parsed.question === "string" ? parsed.question : null,
      // Titles land in a PR, so cap the length and drop newlines.
      prTitle:
        typeof parsed.prTitle === "string" && parsed.prTitle.trim()
          ? parsed.prTitle.replace(/\s+/g, " ").trim().slice(0, 120)
          : null,
      // Hard cap as a backstop: the prompt asks for brevity, this enforces it.
      prBody:
        typeof parsed.prBody === "string" && parsed.prBody.trim()
          ? truncateWords(parsed.prBody.trim(), 150)
          : null,
      plan:
        typeof parsed.plan === "string" && parsed.plan.trim()
          ? truncateWords(parsed.plan.trim(), 160)
          : null,
      // Inline replies must stay short; a wall of text in a code thread is
      // worse than in a comment because it buries the diff.
      replies: Array.isArray(parsed.replies)
        ? (parsed.replies as { commentId?: unknown; body?: unknown }[])
            .filter(
              (r) =>
                typeof r?.commentId === "number" &&
                typeof r?.body === "string" &&
                r.body.trim().length > 0,
            )
            .map((r) => ({
              commentId: r.commentId as number,
              body: truncateWords((r.body as string).trim(), 90),
            }))
        : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "(no summary)",
    };
  } catch {
    return {
      confidence: 0,
      status: "failed",
      question: null,
      prTitle: null,
      prBody: null,
      plan: null,
      replies: [],
      summary: "The verdict block was not valid JSON.",
    };
  }
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(" ")}...`;
}

/** Strip the verdict block so it never leaks into a GitHub comment. */
export function stripVerdict(output: string): string {
  const start = output.lastIndexOf(VERDICT_START);
  return (start === -1 ? output : output.slice(0, start)).trim();
}
