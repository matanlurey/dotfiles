/**
 * Per-issue state.
 *
 * The GitHub thread is the source of truth for content; these files are a cache
 * plus a lock. Anything here can be rebuilt by re-reading the issue and PR,
 * which is what recovery on a corrupt file does.
 *
 * Writes are atomic (write temp, rename) so a crash mid-write cannot leave a
 * half-written record behind.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.ts";

/**
 * Lifecycle of one issue. Terminal states are "done" and "abandoned".
 *
 * claimed -> planning -> implementing -> pr_open -> awaiting_review
 *   awaiting_review -> responding -> awaiting_review   (review round trip)
 *   awaiting_review -> ci_fixing   -> awaiting_review   (red pipeline)
 *   any -> blocked   (needs a human answer)
 *   any -> paused    (budget exhausted)
 *   any -> done      (merged) | abandoned (label removed)
 */
export type Phase =
  | "claimed"
  | "planning"
  | "implementing"
  | "pr_open"
  | "awaiting_review"
  | "responding"
  | "ci_fixing"
  | "merging"
  | "blocked"
  | "paused"
  | "done"
  | "abandoned";

/**
 * A comment awaiting an answer, and where it was left.
 *
 * The surface matters: an issue comment answered on the pull request reads as
 * an unprompted change, because the reader is not looking at what it replies
 * to. Answers go back where the question was asked.
 */
export type PendingComment = {
  source: "issue" | "pr";
  author: string;
  body: string;
  url: string | null;
};

export type IssueState = {
  repo: string;
  issue: number;
  phase: Phase;
  branch: string;
  worktree: string | null;
  prNumber: number | null;
  /** Title proposed by the agent, matching the repo's PR title convention. */
  prTitle: string | null;
  /** Short reviewer-facing PR body proposed by the agent. */
  prBody: string | null;
  /** Login of whoever approved the PR, so status can say it's ready to merge. */
  approvedBy: string | null;
  /** Consecutive phase timeouts. Reset by any phase that completes. */
  timeouts: number;
  /** Conflict resolution attempts, so a hopeless merge can't loop. */
  mergeAttempts: number;
  /** Follow-up issues already filed, to avoid refiling the same one. */
  followUpsFiled: string[];
  /**
   * The last commit this agent pushed, so the status comment can say what it
   * just did rather than only what phase it is in.
   */
  lastPush: { sha: string; kind: string; at: string } | null;
  /** Who review was requested from, so it isn't requested repeatedly. */
  reviewRequestedFrom: string[];
  /**
   * Conversation comments queued for the next responding run.
   *
   * Carried through state because reconcile finds them but the worker is what
   * renders the prompt.
   */
  pendingComments: PendingComment[];
  /**
   * The agent:* label last published, so a cycle can skip the API calls when
   * nothing changed. With a deep queue that is the difference between a few
   * requests and a few hundred per poll.
   */
  statusLabel: string | null;
  /** Digest of the last status comment body, ignoring its timestamp. */
  statusDigest: string | null;
  /**
   * How many times stepping this issue has failed in a row, and with what.
   *
   * A step that fails the same way every cycle will never succeed on its own,
   * and retrying it forever buries real work in the log.
   */
  consecutiveFailures: number;
  lastFailure: string | null;
  /** pi session id, stable per issue so phases share one conversation. */
  sessionId: string;
  /**
   * The agent's single live status comment, edited in place.
   * Cached so periodic progress updates cost one PATCH, not a comment listing.
   */
  statusCommentId: number | null;
  /** Comment ids already processed, so the worker never answers twice. */
  handledCommentIds: number[];
  /** Conversation-tab comments on the PR, which are issue comments on its number. */
  handledPrCommentIds: number[];
  handledReviewIds: number[];
  handledReviewCommentIds: number[];
  /** Head SHA whose CI result we already reacted to. */
  lastCiSha: string | null;
  ciAttempts: number;
  reviewRounds: number;
  usdSpent: number;
  /** Why the issue is blocked or paused, surfaced in /gh-agent status. */
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export function key(repo: string, issue: number): string {
  return `${repo.replace("/", "__")}__${issue}`;
}

function statePath(repo: string, issue: number): string {
  return path.join(STATE_DIR, `${key(repo, issue)}.json`);
}

/**
 * Fill in fields added after a record was written.
 *
 * State files outlive schema changes, so a record written by an older build is
 * missing newer keys. Without this a new optional field reads as `undefined`
 * rather than its default, which slips past `!== null` guards.
 */
function migrate(raw: Partial<IssueState>, repo: string, issue: number): IssueState {
  const base = newState(repo, issue, raw.branch ?? "");
  return {
    ...base,
    ...raw,
    // Explicitly normalize nullable fields: JSON has no undefined, so a missing
    // key must become the documented default rather than leaking undefined.
    statusCommentId: raw.statusCommentId ?? null,
    prNumber: raw.prNumber ?? null,
    prTitle: raw.prTitle ?? null,
    prBody: raw.prBody ?? null,
    approvedBy: raw.approvedBy ?? null,
    timeouts: raw.timeouts ?? 0,
    mergeAttempts: raw.mergeAttempts ?? 0,
    followUpsFiled: raw.followUpsFiled ?? [],
    lastPush: raw.lastPush ?? null,
    reviewRequestedFrom: raw.reviewRequestedFrom ?? [],
    // Older states stored bare strings with no idea where they came from,
    // which is what let an issue comment be answered on the pull request.
    pendingComments: (raw.pendingComments ?? []).map((c: unknown) =>
      typeof c === "string"
        ? { source: "issue" as const, author: "", body: c, url: null }
        : (c as PendingComment),
    ),
    statusLabel: raw.statusLabel ?? null,
    statusDigest: raw.statusDigest ?? null,
    consecutiveFailures: raw.consecutiveFailures ?? 0,
    lastFailure: raw.lastFailure ?? null,
    worktree: raw.worktree ?? null,
    lastCiSha: raw.lastCiSha ?? null,
    note: raw.note ?? null,
    handledCommentIds: raw.handledCommentIds ?? [],
    handledPrCommentIds: raw.handledPrCommentIds ?? [],
    handledReviewIds: raw.handledReviewIds ?? [],
    handledReviewCommentIds: raw.handledReviewCommentIds ?? [],
    ciAttempts: raw.ciAttempts ?? 0,
    reviewRounds: raw.reviewRounds ?? 0,
    usdSpent: raw.usdSpent ?? 0,
  };
}

export function readState(repo: string, issue: number): IssueState | undefined {
  const p = statePath(repo, issue);
  if (!fs.existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<IssueState>;
    return migrate(raw, repo, issue);
  } catch {
    // Corrupt cache: drop it and let the caller rebuild from GitHub.
    fs.rmSync(p, { force: true });
    return undefined;
  }
}

export function writeState(state: IssueState): void {
  const p = statePath(state.repo, state.issue);
  const tmp = `${p}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function allStates(): IssueState[] {
  if (!fs.existsSync(STATE_DIR)) return [];
  const out: IssueState[] = [];
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(STATE_DIR, f), "utf-8"),
      ) as Partial<IssueState>;
      if (!raw.repo || raw.issue === undefined) continue;
      out.push(migrate(raw, raw.repo, raw.issue));
    } catch {
      // Skip unreadable records rather than failing the whole listing.
    }
  }
  return out;
}

export function newState(repo: string, issue: number, branch: string): IssueState {
  const now = new Date().toISOString();
  return {
    repo,
    issue,
    phase: "claimed",
    branch,
    worktree: null,
    prNumber: null,
    prTitle: null,
    prBody: null,
    approvedBy: null,
    timeouts: 0,
    mergeAttempts: 0,
    followUpsFiled: [],
    lastPush: null,
    reviewRequestedFrom: [],
    pendingComments: [],
    statusLabel: null,
    statusDigest: null,
    consecutiveFailures: 0,
    lastFailure: null,
    sessionId: `gh-agent-${key(repo, issue)}`,
    statusCommentId: null,
    handledCommentIds: [],
    handledPrCommentIds: [],
    handledReviewIds: [],
    handledReviewCommentIds: [],
    lastCiSha: null,
    ciAttempts: 0,
    reviewRounds: 0,
    usdSpent: 0,
    note: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isTerminal(phase: Phase): boolean {
  return phase === "done" || phase === "abandoned";
}

/** Phases where the worker waits on a human and must not consume budget. */
export function isIdle(phase: Phase): boolean {
  return phase === "awaiting_review" || phase === "blocked" || phase === "paused";
}

export function archive(repo: string, issue: number): void {
  const p = statePath(repo, issue);
  if (!fs.existsSync(p)) return;
  const dir = path.join(STATE_DIR, "archive");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.renameSync(p, path.join(dir, `${key(repo, issue)}-${Date.now()}.json`));
}

/**
 * Cooperative lock so only one worker runs an issue at a time. Locks store the
 * owning pid; a lock whose process is gone is treated as stale and reclaimed.
 */
/** Locks held by this process, so a signal handler can release them. */
const held = new Set<string>();

export function acquireLock(repo: string, issue: number): boolean {
  const lock = path.join(STATE_DIR, `${key(repo, issue)}.lock`);
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    held.add(lock);
    return true;
  } catch {
    try {
      const pid = Number(fs.readFileSync(lock, "utf-8").trim());
      // Signal 0 tests for existence without actually signalling.
      process.kill(pid, 0);
      return false;
    } catch {
      fs.rmSync(lock, { force: true });
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        held.add(lock);
        return true;
      } catch {
        return false;
      }
    }
  }
}

export function releaseLock(repo: string, issue: number): void {
  const lock = path.join(STATE_DIR, `${key(repo, issue)}.lock`);
  fs.rmSync(lock, { force: true });
  held.delete(lock);
}

/** Drop every lock this process holds. For signal handlers. */
export function releaseAllLocks(): void {
  for (const lock of held) fs.rmSync(lock, { force: true });
  held.clear();
}
