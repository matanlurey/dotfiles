/**
 * The poller. Runs detached from any pi session so work survives closing the TUI.
 *
 * Each cycle reconciles GitHub against local state: claim newly labelled issues,
 * retire ones that got unlabelled or merged, wake blocked issues that got an
 * answer, and route new reviews or red pipelines to the right phase. Only then
 * does it spend budget stepping active issues, at most maxConcurrentIssues at a
 * time.
 *
 * Run directly: node daemon.ts [--once]
 */

import fs from "node:fs";
import { type Config, DAEMON_PID_FILE, ensureDirs, loadConfig } from "./config.ts";
import type { Comment } from "./github.ts";
import { GitHub } from "./github.ts";
import {
  acquireLock,
  allStates,
  archive,
  isIdle,
  isTerminal,
  type IssueState,
  newState,
  readState,
  releaseAllLocks,
  releaseLock,
  writeState,
} from "./state.ts";
import { finish, killChildren, pause, publishQueued, publishStatus, step } from "./worker.ts";

/**
 * Write to stdout only.
 *
 * The launcher redirects stdout to DAEMON_LOG, so also appending to that file
 * here wrote every line twice.
 */
function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function branchFor(cfg: Config, issue: number): string {
  return `${cfg.branchPrefix}issue-${issue}`;
}

async function resolveRepos(cfg: Config, gh: GitHub): Promise<string[]> {
  const installed = await gh.installedRepos();

  if (cfg.repos.length === 0) {
    // A public App can be installed by anyone, and those repos land in
    // installedRepos(). Without an allowlist the daemon would happily start
    // opening PRs in a stranger's repo, so refuse instead.
    if (await gh.appIsPublic()) {
      log(
        'refusing to run: the App accepts installations from any account but config "repos" is empty. ' +
          "Anyone who installs it would get an autonomous worker in their repos. " +
          "List the repos you actually want worked, or make the App private again.",
      );
      return [];
    }
    return installed;
  }

  const allowed = cfg.repos.filter((r) => installed.includes(r));
  const missing = cfg.repos.filter((r) => !installed.includes(r));

  if (missing.length > 0) {
    // An App installed on a user account cannot see org repos, and vice versa.
    // Naming the accounts that do have installations makes that obvious.
    const accounts = (await gh.installations()).map(
      (i) => `${i.account} (${i.selection === "all" ? "all repos" : "selected repos"})`,
    );
    for (const repo of missing) {
      const owner = repo.split("/")[0];
      const hasOwner = (await gh.installations()).some((i) => i.account === owner);
      log(
        hasOwner
          ? `${repo}: the App is installed on ${owner} but that repo isn't granted. Add it under Repository access.`
          : `${repo}: no installation on "${owner}". Install the App on that account. Current installations: ${accounts.join(", ")}`,
      );
    }
  }
  return allowed;
}

/**
 * Decide what an existing issue needs before any budget is spent.
 * Returns true when the issue is ready to be stepped this cycle.
 */
async function reconcile(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  labelled: Set<number>,
): Promise<boolean> {
  if (isTerminal(state.phase)) return false;

  // Label removed: close the PR, delete the branch, shut this worker down.
  if (!labelled.has(state.issue)) {
    await finish(state, cfg, gh, "unlabelled", log);
    return false;
  }

  if (state.prNumber !== null) {
    const pr = await gh.getPr(state.repo, state.prNumber);
    if (pr.merged || pr.merged_at) {
      await finish(state, cfg, gh, "merged", log);
      return false;
    }
    if (pr.state === "closed") {
      log(`PR #${state.prNumber} closed by a human; standing down`);
      await finish(state, cfg, gh, "unlabelled", log);
      return false;
    }
  }

  // Ignore every configured bot, not just this repo's, so two Apps never treat
  // each other's comments as human input.
  const bots = await gh.botLogins();

  /**
   * New human comments on the issue and on the PR's conversation tab.
   *
   * GitHub stores PR conversation comments as issue comments on the PR number,
   * so they need a separate fetch. Only watching the issue meant a comment
   * addressed to the agent on its own PR was silently ignored.
   */
  async function freshHumanComments(): Promise<{ issue: Comment[]; pr: Comment[] }> {
    const onIssue = (await gh.issueComments(state.repo, state.issue)).filter(
      (c) => !bots.includes(c.user.login) && !state.handledCommentIds.includes(c.id),
    );
    const onPr = state.prNumber
      ? (await gh.issueComments(state.repo, state.prNumber)).filter(
          (c) => !bots.includes(c.user.login) && !state.handledPrCommentIds.includes(c.id),
        )
      : [];
    return { issue: onIssue, pr: onPr };
  }

  // A human answering a blocked question is what unblocks it.
  if (state.phase === "blocked") {
    const { issue: onIssue, pr: onPr } = await freshHumanComments();
    const fresh = [...onIssue, ...onPr];
    if (fresh.length === 0) return false;
    state.handledCommentIds.push(...onIssue.map((c) => c.id));
    state.handledPrCommentIds.push(...onPr.map((c) => c.id));
    // Resume where we left off: before a PR exists we re-plan, after it we treat
    // the answer as review-style feedback.
    state.phase = state.prNumber === null ? "planning" : "responding";
    state.note = null;
    writeState(state);
    await publishStatus(
      state,
      cfg,
      gh,
      log,
      `Thanks, picking this back up after ${fresh.length} new comment(s).`,
    );
    log(`${state.repo}#${state.issue} unblocked by ${fresh.length} new comment(s)`);
    return true;
  }

  if (state.phase === "paused") return false;

  if (state.phase === "awaiting_review" && state.prNumber !== null) {
    const prNumber = state.prNumber;

    const reviews = await gh.reviews(state.repo, prNumber);
    const newReviews = reviews.filter(
      (r) => !bots.includes(r.user.login) && !state.handledReviewIds.includes(r.id),
    );
    const reviewComments = await gh.reviewComments(state.repo, prNumber);
    const newComments = reviewComments.filter(
      (c) => !bots.includes(c.user.login) && !state.handledReviewCommentIds.includes(c.id),
    );

    // A comment addressed to the agent counts as feedback even without a
    // formal review attached.
    const { issue: onIssue, pr: onPr } = await freshHumanComments();
    const conversation = [...onIssue, ...onPr];

    // A bare approval is not feedback. Answering it would burn a full phase
    // and invite pointless edits to a change someone just signed off on.
    const actionable = newReviews.filter(
      (r) => r.state === "CHANGES_REQUESTED" || (r.body ?? "").trim().length > 0,
    );

    if (conversation.length > 0) {
      if (state.reviewRounds >= cfg.budget.maxReviewRounds) {
        await pause(
          state,
          gh,
          cfg,
          `I've been through ${state.reviewRounds} rounds on this, which is my limit.`,
          log,
        );
        return false;
      }
      state.handledCommentIds.push(...onIssue.map((c) => c.id));
      state.handledPrCommentIds.push(...onPr.map((c) => c.id));
      state.pendingComments = conversation.map((c) => `@${c.user.login}: ${c.body}`);
      state.phase = "responding";
      writeState(state);
      log(
        `${state.repo}#${state.issue}: ${conversation.length} conversation comment(s) to address`,
      );
      return true;
    }

    if (actionable.length === 0 && newComments.length === 0 && newReviews.length > 0) {
      const approval = newReviews.find((r) => r.state === "APPROVED");
      state.handledReviewIds.push(...newReviews.map((r) => r.id));
      if (approval) state.approvedBy = approval.user.login;
      writeState(state);
      await publishStatus(state, cfg, gh, log);
      log(
        `${state.repo}#${state.issue}: ${newReviews.length} review(s) with no feedback${
          approval ? ` (approved by @${approval.user.login})` : ""
        }, nothing to answer`,
      );
      return false;
    }

    if (actionable.length > 0 || newComments.length > 0) {
      if (state.reviewRounds >= cfg.budget.maxReviewRounds) {
        await pause(
          state,
          gh,
          cfg,
          `I've been through ${state.reviewRounds} review rounds, which is my limit. This probably needs a human to take it the rest of the way.`,
          log,
        );
        return false;
      }
      state.phase = "responding";
      writeState(state);
      log(
        `${state.repo}#${state.issue}: ${actionable.length} review(s) with feedback, ${newComments.length} inline comment(s)`,
      );
      return true;
    }

    const pr = await gh.getPr(state.repo, prNumber);

    // A branch that no longer merges is dead in the water until it catches up,
    // and no amount of CI fixing changes that, so handle it first.
    //
    // mergeable is computed lazily and is null until GitHub finishes, which is
    // not the same as conflicted; leave those for a later cycle.
    const conflicted = pr.mergeable === false || pr.mergeable_state === "dirty";
    const behind = pr.mergeable_state === "behind";
    if (conflicted || behind) {
      if (state.mergeAttempts >= 3) {
        await pause(
          state,
          gh,
          cfg,
          `I've tried ${state.mergeAttempts} times to reconcile this branch with its base and it still doesn't merge. It needs a human.`,
          log,
        );
        return false;
      }
      state.phase = "merging";
      writeState(state);
      log(
        `${state.repo}#${state.issue}: PR #${prNumber} is ${conflicted ? "conflicted" : "behind"} (${pr.mergeable_state})`,
      );
      return true;
    }

    // No review activity: check whether CI needs attention.
    const checks = await gh.checks(state.repo, pr.head.sha);

    if (checks.conclusion === "failure" && state.lastCiSha !== pr.head.sha) {
      if (state.ciAttempts >= cfg.budget.maxCiFixAttempts) {
        await pause(
          state,
          gh,
          cfg,
          `CI is still failing after ${state.ciAttempts} fix attempts:\n\n${checks.failing.map((f) => `- ${f.name}`).join("\n")}\n\nI'd rather stop than keep guessing.`,
          log,
        );
        return false;
      }
      state.lastCiSha = pr.head.sha;
      state.phase = "ci_fixing";
      writeState(state);
      log(`${state.repo}#${state.issue}: CI failing, attempt ${state.ciAttempts + 1}`);
      return true;
    }

    // Green and still a draft: promote so humans know it wants review.
    if (checks.conclusion === "success" && pr.draft && !cfg.dryRun) {
      try {
        await gh.markPrReady(state.repo, prNumber);
        log(`PR #${prNumber} marked ready for review (checks green)`);
      } catch (e) {
        log(`could not mark PR ready: ${(e as Error).message}`);
      }
    }

    // Reviewers may not have been requestable while it was a draft.
    if (!cfg.dryRun && state.reviewRequestedFrom.length === 0 && !pr.draft) {
      const issue = await gh.getIssue(state.repo, state.issue);
      const wanted = cfg.reviewers?.length ? cfg.reviewers : [issue.user.login];
      try {
        const reviewers = await gh.canReview(state.repo, wanted);
        if (reviewers.length > 0) {
          await gh.requestReview(state.repo, prNumber, reviewers);
          state.reviewRequestedFrom = reviewers;
          writeState(state);
          log(`requested review from ${reviewers.join(", ")} on PR #${prNumber}`);
        }
      } catch (e) {
        log(`review request failed: ${(e as Error).message}`);
      }
    }
    return false;
  }

  // Any other non-idle phase is mid-flight work to continue.
  return !isIdle(state.phase);
}

/**
 * Issues currently being stepped, keyed repo#number.
 *
 * Held across cycles so a long run keeps its slot without blocking the rest:
 * awaiting the whole batch meant three issues finishing in a minute sat idle
 * behind one taking sixteen.
 */
const inFlight = new Map<string, Promise<void>>();

async function cycle(cfg: Config, gh: GitHub): Promise<void> {
  const repos = await resolveRepos(cfg, gh);
  if (repos.length === 0) {
    log("no repos available; is the App installed and granted repo access?");
    return;
  }

  const ready: IssueState[] = [];

  for (const repo of repos) {
    let issues;
    try {
      issues = await gh.issuesWithLabel(repo, cfg.label);
    } catch (e) {
      log(`could not list issues for ${repo}: ${(e as Error).message}`);
      continue;
    }
    const labelled = new Set(issues.map((i) => i.number));

    // Claim anything newly labelled.
    for (const issue of issues) {
      if (readState(repo, issue.number)) continue;
      const state = newState(repo, issue.number, branchFor(cfg, issue.number));
      writeState(state);
      log(`claimed ${repo}#${issue.number}: ${issue.title}`);
    }

    // Reconcile everything we know about in this repo.
    for (const state of allStates().filter((s) => s.repo === repo)) {
      if (isTerminal(state.phase)) {
        archive(state.repo, state.issue);
        continue;
      }
      try {
        if (await reconcile(state, cfg, gh, labelled)) ready.push(state);
      } catch (e) {
        log(`reconcile failed for ${repo}#${state.issue}: ${(e as Error).message}`);
      }
    }
  }

  if (ready.length === 0) return;

  // Oldest first, so a busy queue still makes steady progress instead of
  // starving whatever was claimed first.
  ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Only fill the slots that are actually free. Issues already running keep
  // theirs until they finish on their own.
  const free = Math.max(0, cfg.maxConcurrentIssues - inFlight.size);
  const startable = ready.filter((s) => !inFlight.has(`${s.repo}#${s.issue}`));
  const batch = startable.slice(0, free);
  const waiting = startable.slice(free);
  log(
    `starting ${batch.length}, ${inFlight.size} already running, ${waiting.length} waiting (${ready.length} ready)`,
  );

  // Anything ready but not picked is waiting, not working. Saying otherwise
  // makes agent:working useless for telling which issues are actually live.
  for (const [i, state] of waiting.entries()) {
    try {
      await publishQueued(state, cfg, new GitHub(cfg), i + 1, waiting.length, log);
    } catch (e) {
      log(`could not mark ${state.repo}#${state.issue} queued: ${(e as Error).message}`);
    }
  }

  for (const state of batch) {
    const key = `${state.repo}#${state.issue}`;
    if (inFlight.has(key)) continue;
    if (!acquireLock(state.repo, state.issue)) {
      log(`skipping ${key}: locked by another process`);
      continue;
    }
    // Deliberately not awaited. A slot is released the moment its own issue
    // finishes, so one slow issue cannot hold the others idle.
    const run = (async () => {
      try {
        // Re-read: reconcile may have advanced the phase since we queued it.
        const fresh = readState(state.repo, state.issue) ?? state;
        await step(fresh, cfg, new GitHub(cfg), log);
      } catch (e) {
        log(`step failed for ${key}: ${(e as Error).message}`);
      } finally {
        releaseLock(state.repo, state.issue);
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
  }
}

async function main(): Promise<void> {
  ensureDirs();
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const gh = new GitHub(cfg);

  if (!once) fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));

  // Applies to --once too: an interrupted run must not leave a locked issue or
  // an unsupervised pi process behind.
  let shuttingDown = false;
  const cleanup = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`got ${signal}, stopping child runs and releasing locks`);
    killChildren();
    releaseAllLocks();
    if (!once) fs.rmSync(DAEMON_PID_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  const slugs = await gh.botLogins();
  log(
    `daemon up as ${slugs.join(" + ")} (label "${cfg.label}", every ${cfg.pollIntervalSeconds}s, max ${cfg.maxConcurrentIssues} concurrent${cfg.dryRun ? ", DRY RUN" : ""})`,
  );

  for (;;) {
    try {
      await cycle(cfg, gh);
    } catch (e) {
      log(`cycle error: ${(e as Error).message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, cfg.pollIntervalSeconds * 1000));
  }

  // The cycle no longer awaits its own runs, so --once has to.
  if (once && inFlight.size > 0) {
    log(`waiting for ${inFlight.size} in-flight issue(s)`);
    await Promise.all(inFlight.values());
  }
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  killChildren();
  releaseAllLocks();
  fs.rmSync(DAEMON_PID_FILE, { force: true });
  process.exit(1);
});
