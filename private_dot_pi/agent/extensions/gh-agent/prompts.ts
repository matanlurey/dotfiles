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
};

const VERDICT_CONTRACT = `
## Required output contract

End your final message with exactly this block, and nothing after it:

${VERDICT_START}
{"confidence": <0.0-1.0>, "status": "ok" | "needs_help" | "failed", "question": <string or null>, "summary": "<one paragraph>"}
${VERDICT_END}

Rules for the verdict:
- confidence is your honest probability that this phase's work is correct and complete. Do not inflate it.
- status "needs_help" means a human must answer something before you can proceed correctly. Set question to the exact question to post on the issue. Ask about intent, requirements, or tradeoffs. Never ask a question you can answer yourself by reading the repo.
- status "failed" means you could not do the work at all. Explain why in summary.
- Never fabricate progress. If you did not finish, say so.`;

const HOUSE_RULES = `
## Operating rules

- You are working autonomously on a GitHub issue. No human is watching this run.
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
3. Write a short plan: the files you will touch, the approach, and how you will verify it.

Put the plan itself in summary. Keep it under 200 words.
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

1. Address every point. If you disagree with a point, implement nothing for it and explain your reasoning in summary rather than silently ignoring it.
2. Make the edits in the working tree. The harness commits them as a new commit on top, so reviewers keep their context. Never amend or force-push.
3. If a comment asks a question rather than requesting a change, answer it in summary.

In summary, write a reply to the reviewer: what you changed per point, and any pushback with reasoning.
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
      summary: typeof parsed.summary === "string" ? parsed.summary : "(no summary)",
    };
  } catch {
    return {
      confidence: 0,
      status: "failed",
      question: null,
      summary: "The verdict block was not valid JSON.",
    };
  }
}

/** Strip the verdict block so it never leaks into a GitHub comment. */
export function stripVerdict(output: string): string {
  const start = output.lastIndexOf(VERDICT_START);
  return (start === -1 ? output : output.slice(0, start)).trim();
}
