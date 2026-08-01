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
import { type Config, DAEMON_LOG, DAEMON_PID_FILE, ensureDirs, loadConfig } from "./config.ts";
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
  releaseLock,
  writeState,
} from "./state.ts";
import { finish, pause, step } from "./worker.ts";

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(DAEMON_LOG, line);
  } catch {
    // Logging must never take the daemon down.
  }
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

  // A human answering a blocked question is what unblocks it.
  if (state.phase === "blocked") {
    const comments = await gh.issueComments(state.repo, state.issue);
    const fresh = comments.filter(
      (c) => !bots.includes(c.user.login) && !state.handledCommentIds.includes(c.id),
    );
    if (fresh.length === 0) return false;
    state.handledCommentIds.push(...fresh.map((c) => c.id));
    // Resume where we left off: before a PR exists we re-plan, after it we treat
    // the answer as review-style feedback.
    state.phase = state.prNumber === null ? "planning" : "responding";
    state.note = null;
    writeState(state);
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

    if (newReviews.length > 0 || newComments.length > 0) {
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
        `${state.repo}#${state.issue}: ${newReviews.length} review(s), ${newComments.length} inline comment(s)`,
      );
      return true;
    }

    // No review activity: check whether CI needs attention.
    const pr = await gh.getPr(state.repo, prNumber);
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
    return false;
  }

  // Any other non-idle phase is mid-flight work to continue.
  return !isIdle(state.phase);
}

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
  const batch = ready.slice(0, cfg.maxConcurrentIssues);
  log(`stepping ${batch.length} issue(s) (${ready.length} ready)`);

  await Promise.all(
    batch.map(async (state) => {
      if (!acquireLock(state.repo, state.issue)) {
        log(`skipping ${state.repo}#${state.issue}: locked by another process`);
        return;
      }
      try {
        // Re-read: reconcile may have advanced the phase since we queued it.
        const fresh = readState(state.repo, state.issue) ?? state;
        await step(fresh, cfg, new GitHub(cfg), log);
      } catch (e) {
        log(`step failed for ${state.repo}#${state.issue}: ${(e as Error).message}`);
      } finally {
        releaseLock(state.repo, state.issue);
      }
    }),
  );
}

async function main(): Promise<void> {
  ensureDirs();
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const gh = new GitHub(cfg);

  if (!once) {
    fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));
    const cleanup = () => {
      fs.rmSync(DAEMON_PID_FILE, { force: true });
      process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

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
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  fs.rmSync(DAEMON_PID_FILE, { force: true });
  process.exit(1);
});
