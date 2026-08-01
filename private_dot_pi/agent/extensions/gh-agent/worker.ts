/**
 * Per-issue worker: git isolation, headless pi runs, and the phase machine.
 *
 * Isolation model: one cached clone per repo, one git worktree per issue. Two
 * issues in the same repo therefore never share a working tree or an index.
 *
 * The agent never runs git itself (see HOUSE_RULES). This module owns every
 * mutation, which is what keeps "never push to the default branch" and "new
 * commit per review round, never force-push" true by construction rather than
 * by asking the model nicely.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { LOG_DIR, REPO_CACHE_DIR, WORKTREE_DIR } from "./config.ts";
import type { GitHub } from "./github.ts";
import {
  ciFixPrompt,
  implementPrompt,
  parseVerdict,
  planningPrompt,
  questionAnswerPrompt,
  reviewResponsePrompt,
  stripVerdict,
  type Verdict,
} from "./prompts.ts";
import { archive, type IssueState, type Phase, writeState } from "./state.ts";

/** Minimum self-reported confidence to advance out of each phase. */
const THRESHOLD = { planning: 0.6, implementing: 0.5, responding: 0.5, ci_fixing: 0.5 };

/** Wall-clock ceiling per phase. This is the hard budget; prompts state it too. */
const PHASE_TIMEOUT_MS = 25 * 60 * 1000;

export type Logger = (msg: string) => void;

export type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * Children spawned by this process.
 *
 * A SIGTERM aimed at the daemon alone would otherwise leave a pi run editing a
 * worktree with no supervisor and the issue still locked.
 */
const children = new Set<ReturnType<typeof spawn>>();

export function killChildren(): void {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  children.clear();
}

export function exec(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Called as output arrives, for live logging of long runs. */
    onData?: (chunk: string) => void;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        stderr += `\n[killed after ${opts.timeoutMs}ms]`;
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => {
      const s = String(d);
      stdout += s;
      opts.onData?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      opts.onData?.(s);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
  });
}

function repoCachePath(repo: string): string {
  return path.join(REPO_CACHE_DIR, repo.replace("/", "__"));
}

/**
 * Feed the installation token to git without persisting it.
 *
 * Putting the token in the remote URL writes it into .git/config in plaintext,
 * where it outlives the operation. Putting it in argv exposes it to `ps`. A
 * credential helper that reads an env var avoids both: the value lives only in
 * the child process's environment for the duration of the command.
 *
 * The empty first helper clears any inherited system helper (osxkeychain),
 * which would otherwise answer first.
 */
const CRED_ARGS = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_AGENT_TOKEN"; }; f',
];

async function gitAuthed(
  repo: string,
  gh: GitHub,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const token = await gh.token(repo);
  return exec("git", [...CRED_ARGS, ...args], {
    ...opts,
    env: { GH_AGENT_TOKEN: token },
  });
}

/** Clone on first use, fetch afterwards. */
async function ensureClone(repo: string, gh: GitHub, log: Logger): Promise<string> {
  const dir = repoCachePath(repo);
  const remote = gh.remoteUrl(repo);

  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`cloning ${repo}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const res = await gitAuthed(repo, gh, ["clone", "--quiet", remote, dir], {
      timeoutMs: 10 * 60 * 1000,
    });
    if (res.code !== 0) throw new Error(`clone failed: ${scrub(res.stderr)}`);
  } else {
    // Repair a remote left over from an older build that embedded a token.
    await exec("git", ["remote", "set-url", "origin", remote], { cwd: dir });
    const res = await gitAuthed(repo, gh, ["fetch", "--quiet", "--prune", "origin"], {
      cwd: dir,
      timeoutMs: 5 * 60 * 1000,
    });
    if (res.code !== 0) log(`fetch warning: ${scrub(res.stderr)}`);
  }
  return dir;
}

/** Redact anything token-shaped before it reaches a log or an exception. */
export function scrub(text: string): string {
  return text
    .replace(/gh[posur]_[A-Za-z0-9]{10,}/g, "***")
    .replace(/x-access-token:[^@\s]+/g, "x-access-token:***");
}

export async function ensureWorktree(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  log: Logger,
): Promise<string> {
  if (state.worktree && fs.existsSync(state.worktree)) return state.worktree;

  const clone = await ensureClone(state.repo, gh, log);
  const base = await gh.defaultBranch(state.repo);
  const wt = path.join(WORKTREE_DIR, `${state.repo.replace("/", "__")}__${state.issue}`);

  fs.rmSync(wt, { recursive: true, force: true });
  await exec("git", ["worktree", "prune"], { cwd: clone });

  // Reuse the branch if a previous run already pushed it, else branch from base.
  const existing = await exec("git", ["rev-parse", "--verify", `origin/${state.branch}`], {
    cwd: clone,
  });
  const args =
    existing.code === 0
      ? ["worktree", "add", "--force", wt, "-B", state.branch, `origin/${state.branch}`]
      : ["worktree", "add", "--force", wt, "-b", state.branch, `origin/${base}`];

  const res = await exec("git", args, { cwd: clone, timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`worktree add failed: ${res.stderr}`);

  const id = await gh.gitIdentity(state.repo);
  await exec("git", ["config", "user.name", id.name], { cwd: wt });
  await exec("git", ["config", "user.email", id.email], { cwd: wt });

  state.worktree = wt;
  writeState(state);
  log(`worktree ready at ${wt} (branch ${state.branch}, base ${base})`);
  return wt;
}

export function removeWorktree(state: IssueState, log: Logger): void {
  if (!state.worktree) return;
  const clone = repoCachePath(state.repo);
  fs.rmSync(state.worktree, { recursive: true, force: true });
  void exec("git", ["worktree", "prune"], { cwd: clone });
  log(`cleaned worktree for ${state.repo}#${state.issue}`);
}

async function hasChanges(wt: string): Promise<boolean> {
  const res = await exec("git", ["status", "--porcelain"], { cwd: wt });
  return res.stdout.trim().length > 0;
}

async function commitAll(wt: string, message: string): Promise<boolean> {
  if (!(await hasChanges(wt))) return false;
  await exec("git", ["add", "-A"], { cwd: wt });
  const res = await exec("git", ["commit", "-m", message], { cwd: wt });
  return res.code === 0;
}

/**
 * Push the issue branch. Force-push is never used: reviewers keep their
 * "viewed" markers and inline comments stay anchored.
 */
async function push(state: IssueState, gh: GitHub, cfg: Config, log: Logger): Promise<void> {
  if (cfg.dryRun) {
    log(`[dry-run] would push ${state.branch}`);
    return;
  }
  const wt = state.worktree as string;
  // "origin" resolves to the plain URL in the shared clone config; the helper
  // supplies credentials without persisting them.
  const res = await gitAuthed(
    state.repo,
    gh,
    ["push", "--set-upstream", "origin", state.branch],
    { cwd: wt, timeoutMs: 5 * 60 * 1000 },
  );
  if (res.code !== 0) throw new Error(`push failed: ${scrub(res.stderr)}`);
}

async function headSha(wt: string): Promise<string> {
  const res = await exec("git", ["rev-parse", "HEAD"], { cwd: wt });
  return res.stdout.trim();
}

export type RunResult = { verdict: Verdict; output: string; timedOut: boolean };

export type Progress = {
  /** Assistant turns so far. */
  turns: number;
  toolCalls: number;
  /** Most recent tool invocation, worktree prefix stripped. */
  last: string;
  /** Tool name -> count, for a compact breakdown. */
  byTool: Record<string, number>;
};

/**
 * Read live progress from pi's own session transcript.
 *
 * A phase can run for minutes with nothing on stdout, so the tool-call stream
 * is the only honest progress signal available while a run is in flight.
 */
export function readProgress(sessionDir: string): Progress {
  const empty: Progress = { turns: 0, toolCalls: 0, last: "", byTool: {} };
  try {
    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(sessionDir, f));
    if (files.length === 0) return empty;

    const newest = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;

    const out: Progress = { turns: 0, toolCalls: 0, last: "", byTool: {} };
    for (const line of fs.readFileSync(newest, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let entry: { message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      const content = entry.message?.content;
      if (entry.message?.role === "assistant") out.turns += 1;
      if (!Array.isArray(content)) continue;
      for (const block of content as {
        type?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      }[]) {
        if (block.type !== "toolCall") continue;
        const name = block.name ?? "?";
        out.toolCalls += 1;
        out.byTool[name] = (out.byTool[name] ?? 0) + 1;
        const a = block.arguments ?? {};
        out.last = `${name} ${String(a.command ?? a.path ?? a.pattern ?? "")}`.trim();
      }
    }
    // Absolute worktree paths dominate the line and tell a reader nothing.
    // The trailing slash is optional: a bare `cd <worktree>` has none.
    out.last = out.last
      .replace(/\S*\/worktrees\/[^\s/]+\/?/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    return out;
  } catch {
    return empty;
  }
}

export function describeProgress(sessionDir: string): string {
  const p = readProgress(sessionDir);
  if (p.toolCalls === 0) return p.turns > 0 ? "thinking" : "starting up";
  return `${p.toolCalls} tool calls, last: ${p.last}`;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Update the live status comment with running metrics.
 *
 * Deliberately one PATCH against a cached comment id: no label churn, no
 * comment listing. GitHub does not notify subscribers on edits, so this stays
 * quiet in everyone's inbox no matter how often it ticks.
 */
async function updateProgressComment(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  elapsedMs: number,
  progress: Progress,
  log: Logger,
): Promise<void> {
  if (cfg.dryRun || state.statusCommentId === null) return;

  const tools = Object.entries(progress.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} ${c}`)
    .join(", ");

  const body = [
    STATUS_MARKER,
    `**Agent status: ${state.phase.replace(/_/g, " ")}**`,
    "",
    `Working for ${humanDuration(elapsedMs)} of a ${Math.round(PHASE_TIMEOUT_MS / 60000)} minute budget.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Turns | ${progress.turns} |`,
    `| Tool calls | ${progress.toolCalls} |`,
    tools ? `| Breakdown | ${tools} |` : "",
    progress.last ? `| Currently | \`${progress.last.replace(/`/g, "'")}\` |` : "",
    "",
    state.prNumber ? `Pull request: #${state.prNumber}\n` : "",
    `<sub>Branch \`${state.branch}\`. This comment updates in place.` +
      ` Remove the \`${cfg.label}\` label to stop me.</sub>`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    await gh.updateComment(state.repo, state.statusCommentId, body);
  } catch (e) {
    log(`progress update failed: ${(e as Error).message}`);
  }
}

/**
 * Run one headless pi turn in the issue's worktree.
 *
 * The session id is stable per issue, so planning, implementation, review
 * responses and CI fixes all share one conversation and the agent remembers
 * its own earlier reasoning.
 */
export async function runPi(
  prompt: string,
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  log: Logger,
): Promise<RunResult> {
  const wt = state.worktree as string;
  const sessionDir = path.join(LOG_DIR, "sessions", `${state.repo.replace("/", "__")}__${state.issue}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const args = [
    "-p",
    prompt,
    "--model",
    cfg.model,
    "--thinking",
    cfg.thinking,
    "--session-id",
    state.sessionId,
    "--session-dir",
    sessionDir,
    // Trust project-local AGENTS.md/CLAUDE.md so repo conventions are honored.
    "-a",
  ];

  // Strip the human's GitHub credentials from the child environment.
  //
  // The agent has bash, and an inherited `gh` login would let it act as the
  // repo owner: renaming PRs, merging, deleting branches. That bypasses the
  // App's permission scope, the repo allowlist, and the no-auto-merge rule,
  // and misattributes the action to a human. The harness owns every GitHub
  // mutation, so the child gets no usable credential.
  const blindDir = path.join(sessionDir, "no-credentials");
  fs.mkdirSync(blindDir, { recursive: true });
  const sanitizedEnv: NodeJS.ProcessEnv = {
    PI_GH_AGENT: "1",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GH_CONFIG_DIR: blindDir,
    // Neutralize credential helpers and any push-rewriting url.insteadOf rules.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
  };

  // Stream to the log as output arrives so `tail -f` works during the run,
  // rather than the file appearing only after the phase ends.
  const logFile = path.join(
    LOG_DIR,
    `${state.repo.replace("/", "__")}__${state.issue}-${Date.now()}.log`,
  );
  const sink = fs.createWriteStream(logFile, { flags: "a" });
  sink.write(`$ pi ${args.join(" ")}\n\n`);

  log(`running pi (${cfg.model}) in ${wt}`);
  log(`  live log: ${logFile}`);
  const started = Date.now();

  // Log locally every 30s; push to the issue every 4th tick (2 min) so the
  // comment stays current without hammering the API.
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    const elapsed = Date.now() - started;
    const budget = Math.round(PHASE_TIMEOUT_MS / 60000);
    log(
      `  still working (${Math.round(elapsed / 60000)}/${budget} min): ${describeProgress(sessionDir)}`,
    );
    if (ticks % 4 === 0) {
      void updateProgressComment(state, cfg, gh, elapsed, readProgress(sessionDir), log);
    }
  }, 30_000);

  let res: ExecResult;
  try {
    res = await exec("pi", args, {
      cwd: wt,
      timeoutMs: PHASE_TIMEOUT_MS,
      env: sanitizedEnv,
      onData: (chunk) => sink.write(chunk),
    });
  } finally {
    clearInterval(heartbeat);
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  const timedOut = res.stderr.includes("[killed after");
  sink.end(`\n--- stderr ---\n${scrub(res.stderr)}\n`);
  log(`pi finished in ${elapsed}s (exit ${res.code}, log ${path.basename(logFile)})`);

  if (timedOut) {
    return {
      timedOut: true,
      output: res.stdout,
      verdict: {
        confidence: 0,
        status: "failed",
        question: null,
        prTitle: null,
        summary: `The run hit the ${Math.round(PHASE_TIMEOUT_MS / 60000)} minute phase budget and was stopped.`,
      },
    };
  }

  return { timedOut: false, output: res.stdout, verdict: parseVerdict(res.stdout) };
}

const SIG = "\n\n<sub>Posted automatically by the issue agent.</sub>";

/**
 * Hidden marker identifying the agent's single live status comment.
 *
 * A GitHub App's bot user cannot be assigned to an issue, so a status comment
 * plus a label is how the agent signals "I have this". The comment is edited in
 * place rather than reposted, to avoid burying the discussion in bot noise.
 */
const STATUS_MARKER = "<!-- gh-agent-status -->";

/** Phase -> the label shown on the issue, and how it reads to a human. */
const STATUS_LABEL: Partial<Record<Phase, { label: string; color: string; blurb: string }>> = {
  claimed: { label: "agent:working", color: "1D76DB", blurb: "Picking this up." },
  planning: { label: "agent:working", color: "1D76DB", blurb: "Reading the code and working out a plan." },
  implementing: { label: "agent:working", color: "1D76DB", blurb: "Writing the change." },
  pr_open: { label: "agent:working", color: "1D76DB", blurb: "Opening a pull request." },
  awaiting_review: { label: "agent:in-review", color: "0E8A16", blurb: "Pull request is up and waiting on review." },
  responding: { label: "agent:working", color: "1D76DB", blurb: "Addressing review feedback." },
  ci_fixing: { label: "agent:working", color: "1D76DB", blurb: "CI went red. Investigating." },
  blocked: { label: "agent:needs-input", color: "D93F0B", blurb: "Waiting on an answer from you." },
  paused: { label: "agent:paused", color: "5319E7", blurb: "Stopped. Needs a human to take it forward." },
};

const ALL_STATUS_LABELS = [
  "agent:working",
  "agent:in-review",
  "agent:needs-input",
  "agent:paused",
];

/**
 * Publish the current phase to the issue: one edited-in-place status comment
 * and one mutually exclusive label.
 *
 * Best effort by design. A failure to report status must never abort real work,
 * so everything here is wrapped and logged rather than thrown.
 */
export async function publishStatus(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  log: Logger,
  detail?: string,
): Promise<void> {
  const entry = STATUS_LABEL[state.phase];
  if (!entry) return;

  if (cfg.dryRun) {
    log(`[dry-run] status -> ${entry.label}: ${detail ?? entry.blurb}`);
    return;
  }

  try {
    await gh.ensureLabel(state.repo, entry.label, entry.color, "Set by the autonomous issue agent");
    for (const stale of ALL_STATUS_LABELS) {
      if (stale !== entry.label) await gh.removeLabel(state.repo, state.issue, stale);
    }
    await gh.addLabels(state.repo, state.issue, [entry.label]);
  } catch (e) {
    log(`status label failed: ${(e as Error).message}`);
  }

  const pr = state.prNumber ? `\n\nPull request: #${state.prNumber}` : "";
  const body = [
    STATUS_MARKER,
    `**Agent status: ${state.phase.replace(/_/g, " ")}**`,
    "",
    detail ?? entry.blurb,
    pr,
    "",
    `<sub>Branch \`${state.branch}\`. Updated ${new Date().toISOString().replace("T", " ").slice(0, 16)}Z.` +
      ` Remove the \`${cfg.label}\` label to stop me.</sub>`,
  ].join("\n");

  try {
    // Reuse the cached id when we have it; otherwise find or create the comment
    // and remember it so later progress ticks are a single PATCH.
    if (state.statusCommentId !== null) {
      await gh.updateComment(state.repo, state.statusCommentId, body);
      return;
    }
    const existing = (await gh.issueComments(state.repo, state.issue)).find((c) =>
      c.body.includes(STATUS_MARKER),
    );
    if (existing) {
      await gh.updateComment(state.repo, existing.id, body);
      state.statusCommentId = existing.id;
    } else {
      const created = await gh.comment(state.repo, state.issue, body);
      if (created) state.statusCommentId = created.id;
    }
    writeState(state);
  } catch (e) {
    log(`status comment failed: ${(e as Error).message}`);
  }
}

/** Clear agent labels when the agent is done with an issue. */
async function clearStatusLabels(state: IssueState, cfg: Config, gh: GitHub): Promise<void> {
  if (cfg.dryRun) return;
  for (const l of ALL_STATUS_LABELS) {
    try {
      await gh.removeLabel(state.repo, state.issue, l);
    } catch {
      // Best effort.
    }
  }
}

async function block(
  state: IssueState,
  gh: GitHub,
  cfg: Config,
  question: string,
  log: Logger,
): Promise<void> {
  state.phase = "blocked";
  state.note = question;
  writeState(state);
  if (cfg.dryRun) {
    log(`[dry-run] would ask: ${question}`);
    return;
  }
  await gh.comment(
    state.repo,
    state.issue,
    `I need input before I can continue.\n\n${question}\n\nReply on this issue and I'll pick it back up.${SIG}`,
  );
  await publishStatus(state, cfg, gh, log, `Waiting on an answer:\n\n> ${question.split("\n")[0]}`);
  log(`blocked on question for ${state.repo}#${state.issue}`);
}

async function pause(
  state: IssueState,
  gh: GitHub,
  cfg: Config,
  reason: string,
  log: Logger,
): Promise<void> {
  state.phase = "paused";
  state.note = reason;
  writeState(state);
  if (!cfg.dryRun) {
    await gh.comment(
      state.repo,
      state.issue,
      `I've stopped working on this for now.\n\n${reason}\n\nRemove and re-add the \`${cfg.label}\` label to restart me.${SIG}`,
    );
  }
  await publishStatus(state, cfg, gh, log, reason);
  log(`paused ${state.repo}#${state.issue}: ${reason}`);
}

/**
 * Drive one issue forward by a single phase. Returns when the issue is idle,
 * terminal, or has consumed its step for this poll cycle.
 */
export async function step(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  log: Logger,
): Promise<void> {
  const issue = await gh.getIssue(state.repo, state.issue);

  switch (state.phase) {
    case "claimed": {
      await ensureWorktree(state, cfg, gh, log);
      await publishStatus(
        state,
        cfg,
        gh,
        log,
        "Picking this up. I'll read the code, post a plan here, and only then start writing.",
      );
      state.phase = "planning";
      writeState(state);
      return;
    }

    case "planning": {
      await ensureWorktree(state, cfg, gh, log);
      await publishStatus(state, cfg, gh, log);
      const comments = await gh.issueComments(state.repo, state.issue);
      const thread = comments
        .map((c) => `**@${c.user.login}**: ${c.body}`)
        .join("\n\n");
      const { verdict } = await runPi(planningPrompt(issue, thread), state, cfg, gh, log);

      if (verdict.status === "needs_help" && verdict.question) {
        await block(state, gh, cfg, verdict.question, log);
        return;
      }
      if (verdict.status === "failed" || verdict.confidence < THRESHOLD.planning) {
        await block(
          state,
          gh,
          cfg,
          `I couldn't produce a plan I trust (confidence ${verdict.confidence.toFixed(2)}).\n\n${verdict.summary}\n\nCould you clarify what you want here?`,
          log,
        );
        return;
      }

      state.note = verdict.summary;
      state.phase = "implementing";
      writeState(state);
      // The plan is real content, so it gets its own durable comment rather
      // than being folded into the mutable status comment.
      if (!cfg.dryRun) {
        await gh.comment(
          state.repo,
          state.issue,
          `Here's my plan (confidence ${verdict.confidence.toFixed(2)}):\n\n${verdict.summary}\n\nStarting work now.${SIG}`,
        );
      }
      await publishStatus(state, cfg, gh, log);
      return;
    }

    case "implementing": {
      const wt = await ensureWorktree(state, cfg, gh, log);
      await publishStatus(state, cfg, gh, log);
      const plan = state.note ?? "(plan unavailable, re-derive from the issue)";
      const { verdict } = await runPi(implementPrompt(issue, plan), state, cfg, gh, log);

      if (verdict.status === "needs_help" && verdict.question) {
        await block(state, gh, cfg, verdict.question, log);
        return;
      }
      if (verdict.status === "failed" || verdict.confidence < THRESHOLD.implementing) {
        await block(
          state,
          gh,
          cfg,
          `I attempted the change but I'm not confident in it (confidence ${verdict.confidence.toFixed(2)}).\n\n${verdict.summary}\n\nHow would you like me to proceed?`,
          log,
        );
        return;
      }

      // Remember a proposed title so pr_open can use it. Many repos gate CI on
      // a Conventional Commits PR title, which the raw issue title rarely is.
      if (verdict.prTitle) {
        state.prTitle = verdict.prTitle;
        writeState(state);
      }

      const committed = await commitAll(wt, `${issue.title}\n\nCloses #${issue.number}`);
      if (!committed) {
        await block(
          state,
          gh,
          cfg,
          `The run reported success but left no changes in the working tree, so there's nothing to open a PR with.\n\n${verdict.summary}`,
          log,
        );
        return;
      }

      await push(state, gh, cfg, log);
      state.note = verdict.summary;
      state.phase = "pr_open";
      writeState(state);
      return;
    }

    case "pr_open": {
      if (cfg.dryRun) {
        log(`[dry-run] would open PR for ${state.repo}#${state.issue}`);
        state.phase = "awaiting_review";
        writeState(state);
        return;
      }
      // Don't assume the implementing phase pushed. It may have been skipped
      // (dry run at the time) or interrupted. Pushing again is a no-op.
      await ensureWorktree(state, cfg, gh, log);
      await push(state, gh, cfg, log);
      const base = await gh.defaultBranch(state.repo);
      const pr = await gh.createPr(state.repo, {
        title: state.prTitle ?? issue.title,
        body: `Closes #${issue.number}\n\n${state.note ?? ""}\n\n---\n\nOpened autonomously from the \`${cfg.label}\` label. Review comments get a new commit in reply, never a force-push.`,
        head: state.branch,
        base,
        draft: cfg.openPrAsDraft,
      });
      state.prNumber = pr.number;
      state.phase = "awaiting_review";
      writeState(state);
      await gh.comment(
        state.repo,
        state.issue,
        cfg.openPrAsDraft
          ? `Opened ${pr.html_url} as a draft. I'll mark it ready for review once checks pass.${SIG}`
          : `Opened ${pr.html_url}.${SIG}`,
      );
      await publishStatus(state, cfg, gh, log);
      log(`opened PR #${pr.number} for ${state.repo}#${state.issue}`);
      return;
    }

    case "responding": {
      const wt = await ensureWorktree(state, cfg, gh, log);
      await publishStatus(state, cfg, gh, log);
      const prNumber = state.prNumber as number;
      const reviews = (await gh.reviews(state.repo, prNumber)).filter(
        (r) => !state.handledReviewIds.includes(r.id),
      );
      const comments = (await gh.reviewComments(state.repo, prNumber)).filter(
        (c) => !state.handledReviewCommentIds.includes(c.id),
      );

      const { verdict } = await runPi(
        reviewResponsePrompt(issue, reviews, comments),
        state,
        cfg,
        gh,
        log,
      );

      // Mark handled regardless of outcome so one bad round can't loop forever.
      state.handledReviewIds.push(...reviews.map((r) => r.id));
      state.handledReviewCommentIds.push(...comments.map((c) => c.id));
      state.reviewRounds += 1;

      if (verdict.status === "needs_help" && verdict.question) {
        writeState(state);
        await block(state, gh, cfg, verdict.question, log);
        return;
      }

      const committed = await commitAll(
        wt,
        `Address review feedback\n\nRe: PR #${prNumber}`,
      );
      if (committed) await push(state, gh, cfg, log);

      if (!cfg.dryRun) {
        const reply = stripVerdict(verdict.summary) || verdict.summary;
        await gh.comment(
          state.repo,
          prNumber,
          `${reply}${committed ? "" : "\n\n(No code changes were needed for this round.)"}${SIG}`,
        );
      }

      state.phase = "awaiting_review";
      state.note = null;
      writeState(state);
      await publishStatus(state, cfg, gh, log);
      log(`answered review round ${state.reviewRounds} on PR #${prNumber}`);
      return;
    }

    case "ci_fixing": {
      const wt = await ensureWorktree(state, cfg, gh, log);
      const prNumber = state.prNumber as number;
      const pr = await gh.getPr(state.repo, prNumber);
      const checks = await gh.checks(state.repo, pr.head.sha);
      await publishStatus(
        state,
        cfg,
        gh,
        log,
        `CI went red on \`${pr.head.sha.slice(0, 7)}\`. Investigating: ${checks.failing.map((f) => f.name).join(", ")}`,
      );

      const logs = await failureLogs(state, checks, gh);
      const { verdict } = await runPi(ciFixPrompt(issue, checks, logs), state, cfg, gh, log);
      state.ciAttempts += 1;

      // A red "validate PR title" style check is fixed by retitling, which only
      // the harness can do.
      if (verdict.prTitle && verdict.prTitle !== state.prTitle && state.prNumber) {
        state.prTitle = verdict.prTitle;
        writeState(state);
        try {
          await gh.updatePrTitle(state.repo, state.prNumber, verdict.prTitle);
          log(`retitled PR #${state.prNumber}: ${verdict.prTitle}`);
        } catch (e) {
          log(`retitle failed: ${(e as Error).message}`);
        }
      }

      if (verdict.status === "needs_help" && verdict.question) {
        writeState(state);
        await block(state, gh, cfg, verdict.question, log);
        return;
      }

      const committed = await commitAll(wt, `Fix CI\n\n${verdict.summary.slice(0, 200)}`);
      if (committed) {
        await push(state, gh, cfg, log);
        state.lastCiSha = await headSha(wt);
      }
      state.phase = "awaiting_review";
      writeState(state);
      await publishStatus(state, cfg, gh, log);
      log(`CI fix attempt ${state.ciAttempts} pushed=${committed}`);
      return;
    }

    default:
      return;
  }
}

/** Best-effort failing-job logs for the CI fix prompt. */
async function failureLogs(
  state: IssueState,
  checks: { failing: { name: string; url: string }[] },
  gh: GitHub,
): Promise<string> {
  const out: string[] = [];
  for (const f of checks.failing.slice(0, 3)) {
    const m = f.url.match(/\/runs\/(\d+)\/job\/(\d+)/) ?? f.url.match(/\/job\/(\d+)/);
    if (!m) continue;
    const jobId = m[m.length - 1];
    try {
      const token = await gh.token(state.repo);
      const res = await fetch(
        `https://api.github.com/repos/${state.repo}/actions/jobs/${jobId}/logs`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "matanlurey-agent-worker",
          },
          redirect: "follow",
        },
      );
      if (res.ok) {
        const text = await res.text();
        // Tail is where the failure actually is; the head is setup noise.
        out.push(`### ${f.name}\n${text.slice(-6000)}`);
      }
    } catch {
      // Logs are a nice-to-have; the agent can still reproduce locally.
    }
  }
  return out.join("\n\n");
}

export async function finish(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  reason: "merged" | "unlabelled",
  log: Logger,
): Promise<void> {
  if (reason === "unlabelled" && state.prNumber && !cfg.dryRun) {
    try {
      await gh.closePr(state.repo, state.prNumber);
      await gh.comment(
        state.repo,
        state.prNumber,
        `Closing: the \`${cfg.label}\` label was removed from #${state.issue}.${SIG}`,
      );
      await gh.deleteBranch(state.repo, state.branch);
    } catch (e) {
      log(`cleanup warning: ${(e as Error).message}`);
    }
  }
  // Leave no stale "I'm working on this" signal behind.
  await clearStatusLabels(state, cfg, gh);
  if (reason === "merged" && !cfg.dryRun) {
    try {
      const existing = (await gh.issueComments(state.repo, state.issue)).find((c) =>
        c.body.includes(STATUS_MARKER),
      );
      if (existing) {
        await gh.updateComment(
          state.repo,
          existing.id,
          `${STATUS_MARKER}\n**Agent status: done**\n\nMerged in #${state.prNumber}. Standing down.`,
        );
      }
    } catch {
      // Best effort.
    }
  }
  removeWorktree(state, log);
  state.phase = reason === "merged" ? "done" : "abandoned";
  writeState(state);
  archive(state.repo, state.issue);
  log(`finished ${state.repo}#${state.issue} (${reason})`);
}

export { pause, THRESHOLD };
