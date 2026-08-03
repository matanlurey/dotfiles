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
  conflictPrompt,
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

/** Fallback when config omits phaseTimeoutMinutes. */
function phaseTimeoutMs(cfg: Config): number {
  return (cfg.phaseTimeoutMinutes ?? 25) * 60 * 1000;
}

export type Logger = (msg: string) => void;

export type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * Children spawned by this process.
 *
 * A SIGTERM aimed at the daemon alone would otherwise leave a pi run editing a
 * worktree with no supervisor and the issue still locked.
 */
const children = new Set<ReturnType<typeof spawn>>();

/**
 * Kill a child and everything it spawned.
 *
 * Signalling only the direct child leaves its descendants (cargo, rustc)
 * running and holding the stdio pipes open, so the run keeps going past its
 * budget. Each child is its own process group leader, so the negative pid
 * signals the whole tree.
 */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export function killChildren(): void {
  for (const c of children) killTree(c, "SIGTERM");
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
      // Own process group, so a timeout can kill descendants too.
      detached: true,
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        stderr += `\n[killed after ${opts.timeoutMs}ms]`;
        killTree(child, "SIGKILL");
        // Descendants can keep the pipes open past the kill; don't wait on them.
        setTimeout(() => {
          children.delete(child);
          resolve({ code: -1, stdout, stderr });
        }, 5000);
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

/** Worktree paths that currently have the given branch checked out. */
async function worktreesHolding(clone: string, branch: string): Promise<string[]> {
  const res = await exec("git", ["worktree", "list", "--porcelain"], { cwd: clone });
  if (res.code !== 0) return [];
  const held: string[] = [];
  let current: string | null = null;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}` && current) held.push(current);
  }
  return held;
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

  // A branch checked out in some other worktree cannot be reset, even with -B.
  // That happens when a path changes or an earlier run left one registered, so
  // detach any worktree still holding this branch before touching it.
  for (const held of await worktreesHolding(clone, state.branch)) {
    if (held === wt) continue;
    log(`detaching stale worktree ${held} holding ${state.branch}`);
    await exec("git", ["worktree", "remove", "--force", held], { cwd: clone });
  }
  await exec("git", ["worktree", "prune"], { cwd: clone });

  // Reuse the branch if a previous run already pushed it, else branch from base.
  const existing = await exec("git", ["rev-parse", "--verify", `origin/${state.branch}`], {
    cwd: clone,
  });

  // A PR means the remote branch must exist. If it doesn't, something outside
  // this agent deleted it, and resetting from base would quietly throw away
  // reviewed work, so stop instead.
  if (existing.code !== 0 && state.prNumber) {
    throw new Error(
      `PR #${state.prNumber} exists but origin/${state.branch} is gone; refusing to recreate it from ${base}`,
    );
  }

  // -B in both cases, not -b. An aborted run can leave a local branch with no
  // remote, and -b fails outright on that, which retried every cycle forever.
  // Resetting is safe here precisely because there is no PR and no remote.
  const args =
    existing.code === 0
      ? ["worktree", "add", "--force", wt, "-B", state.branch, `origin/${state.branch}`]
      : ["worktree", "add", "--force", wt, "-B", state.branch, `origin/${base}`];

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
async function push(
  state: IssueState,
  gh: GitHub,
  cfg: Config,
  log: Logger,
  kind = "work",
): Promise<void> {
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

  // Record what this push was for so the status comment can report one line
  // per commit instead of only naming the current phase.
  state.lastPush = {
    sha: (await headSha(wt)).slice(0, 7),
    kind,
    at: new Date().toISOString(),
  };
  writeState(state);
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

/** Cut long prose at a sentence boundary rather than mid-word. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const stop = cut.lastIndexOf(". ");
  return `${stop > maxChars / 2 ? cut.slice(0, stop + 1) : cut}...`;
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
    `${STATUS_MARKER}\n**Agent status: ${state.phase.replace(/_/g, " ")}**`,
    `Working for ${humanDuration(elapsedMs)} of a ${Math.round(phaseTimeoutMs(cfg) / 60000)} minute budget.`,
    [
      `| | |`,
      `|---|---|`,
      `| Turns | ${progress.turns} |`,
      `| Tool calls | ${progress.toolCalls} |`,
      tools ? `| Breakdown | ${tools} |` : "",
      progress.last ? `| Currently | \`${progress.last.replace(/`/g, "'")}\` |` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    state.prNumber ? `Pull request: #${state.prNumber}` : "",
    `<sub>Branch \`${state.branch}\`. This comment updates in place.` +
      ` Remove the \`${cfg.label}\` label to stop me.</sub>`,
  ]
    .filter(Boolean)
    .join("\n\n");

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
/**
 * Pick the model for this run.
 *
 * A phase that already timed out or failed once escalates, because rerunning
 * the same prompt on the same model reproduces the same failure. Otherwise a
 * per-phase override wins, then the default.
 */
export function modelFor(state: IssueState, cfg: Config): { model: string; thinking: string } {
  if (state.timeouts > 0 && cfg.escalationModel) {
    return { model: cfg.escalationModel, thinking: cfg.escalationThinking ?? cfg.thinking };
  }
  return {
    model: cfg.modelByPhase?.[state.phase] ?? cfg.model,
    thinking: cfg.thinking,
  };
}

/**
 * Whether a run died because its resumed session is no longer replayable.
 *
 * One session is reused across an issue's phases, and the provider rejects a
 * resume whose recorded thinking blocks do not come back byte for byte. The
 * run then exits in seconds having done nothing, which is not a result and
 * must not be reported as one.
 */
function sessionPoisoned(output: string, stderr: string): boolean {
  const all = `${output}\n${stderr}`;
  // Anchored on the provider's wording rather than the words "thinking" and
  // "blocks", which the agent can easily write about a codebase in passing.
  return (
    /blocks in the latest assistant message cannot be modified/.test(all) ||
    /blocks must remain as they were in the original response/.test(all)
  );
}

export async function runPi(
  prompt: string,
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  log: Logger,
  retried = false,
): Promise<RunResult> {
  const wt = state.worktree as string;
  const sessionDir = path.join(LOG_DIR, "sessions", `${state.repo.replace("/", "__")}__${state.issue}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { model, thinking } = modelFor(state, cfg);
  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--thinking",
    thinking,
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
    // SSH is a second, quieter credential path to the same repos.
    //
    // Blocking the HTTPS token is not enough: the child inherits HOME, so ssh
    // finds the key in ~/.ssh on its own, with no agent involved. `ssh -T
    // git@github.com` from a worker answers "Hi matanlurey", which is a push
    // to any repo as the owner, around the App's scope, the repo allowlist and
    // every branch rule the harness enforces.
    SSH_AUTH_SOCK: "",
    GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_SSH: "/usr/bin/false",
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

  log(
    `running pi (${model}${state.timeouts > 0 ? `, escalated after ${state.timeouts} timeout(s)` : ""}) in ${wt}`,
  );
  log(`  live log: ${logFile}`);
  const started = Date.now();

  // Log locally every 30s; push to the issue every 4th tick (2 min) so the
  // comment stays current without hammering the API.
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    const elapsed = Date.now() - started;
    const budget = Math.round(phaseTimeoutMs(cfg) / 60000);
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
      timeoutMs: phaseTimeoutMs(cfg),
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
        prBody: null,
        plan: null,
        replies: [],
        followUps: [],
        reply: null,
        summary: `The run hit the ${Math.round(phaseTimeoutMs(cfg) / 60000)} minute phase budget and was stopped.`,
      },
    };
  }

  // A resumed session the provider will not accept can only fail the same way
  // again. Start a clean one and rerun the phase; the prompt is self-contained,
  // so only the agent's earlier exploration is lost.
  if (sessionPoisoned(res.stdout, res.stderr) && !retried) {
    state.sessionId = `${state.sessionId}-r${Date.now().toString(36)}`;
    writeState(state);
    log(`session rejected by the provider, retrying ${state.repo}#${state.issue} with a fresh one`);
    return runPi(prompt, state, cfg, gh, log, true);
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
  merging: { label: "agent:working", color: "1D76DB", blurb: "Catching up with the base branch." },
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
  "agent:queued",
  "agent:in-review",
  "agent:needs-input",
  "agent:paused",
];

/**
 * Mark an issue as started but not currently progressing.
 *
 * Concurrency is bounded, so most in-flight issues are waiting for a slot at
 * any moment. Leaving them labelled agent:working overstates what is happening
 * and makes the label useless for telling which issues are live.
 */
export async function publishQueued(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  position: number,
  total: number,
  log: Logger,
): Promise<void> {
  if (cfg.dryRun || state.statusLabel === "agent:queued") return;
  try {
    await gh.ensureLabel(
      state.repo,
      "agent:queued",
      "C5DEF5",
      "Started by the agent, waiting for a worker slot",
    );
    for (const stale of ALL_STATUS_LABELS) {
      if (stale !== "agent:queued") await gh.removeLabel(state.repo, state.issue, stale);
    }
    await gh.addLabels(state.repo, state.issue, ["agent:queued"]);
    state.statusLabel = "agent:queued";
    writeState(state);
    log(`${state.repo}#${state.issue} queued (${position}/${total})`);
  } catch (e) {
    log(`queue label failed: ${(e as Error).message}`);
  }
}

/**
 * What the agent is waiting on, when it is waiting on a person.
 *
 * Stated explicitly so nobody has to infer from a phase name whether the ball
 * is in their court.
 */
/** One line describing the most recent push, for the status comment. */
function lastPushLine(state: IssueState): string | undefined {
  if (!state.lastPush) return undefined;
  const { sha, kind, at } = state.lastPush;
  const when = at.replace("T", " ").slice(0, 16);
  return `Last push: \`${sha}\` (${kind}) at ${when}Z.`;
}

function waitingOn(state: IssueState): string | undefined {
  switch (state.phase) {
    case "awaiting_review":
      if (!state.prNumber) return "**Waiting for a human to review.**";
      return state.approvedBy
        ? `**Approved by @${state.approvedBy}. Waiting for a human to merge #${state.prNumber}.** I don't merge my own work.`
        : `**Waiting for a human to review and approve #${state.prNumber}.** I won't merge it myself.`;
    case "blocked":
      return "**Waiting for a human to answer my question.** Reply on this issue and I'll pick it straight back up.";
    case "paused":
      return "**Waiting for a human to take this forward.** Remove and re-add the label to restart me.";
    default:
      return undefined;
  }
}

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

  // Skip the label churn when nothing changed; a deep queue makes this the
  // difference between a handful of API calls per cycle and hundreds.
  if (state.statusLabel !== entry.label) {
    try {
      await gh.ensureLabel(
        state.repo,
        entry.label,
        entry.color,
        "Set by the autonomous issue agent",
      );
      for (const stale of ALL_STATUS_LABELS) {
        if (stale !== entry.label) await gh.removeLabel(state.repo, state.issue, stale);
      }
      await gh.addLabels(state.repo, state.issue, [entry.label]);
      // Persist immediately. Callers write state at their own times, and a
      // caller that wrote before calling this leaves the cache claiming a
      // label that was never published. The skip check then believes it is
      // already correct and the stale label survives every later cycle.
      state.statusLabel = entry.label;
      writeState(state);
    } catch (e) {
      log(`status label failed: ${(e as Error).message}`);
    }
  }

  const waiting = waitingOn(state);
  // Joined with blank lines so each block is its own markdown paragraph.
  const body = [
    `${STATUS_MARKER}\n**Agent status: ${state.phase.replace(/_/g, " ")}**`,
    waiting ?? detail ?? entry.blurb,
    waiting && detail ? detail : "",
    lastPushLine(state) ?? "",
    state.prNumber && !waiting ? `Pull request: #${state.prNumber}` : "",
    `<sub>Branch \`${state.branch}\`. Updated ${new Date().toISOString().replace("T", " ").slice(0, 16)}Z.` +
      ` Remove the \`${cfg.label}\` label to stop me.</sub>`,
  ]
    .filter(Boolean)
    .join("\n\n");

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

/**
 * A phase timeout is not a question a human can answer.
 *
 * Asking "could you clarify?" after running out of time invites a reply that
 * starts the same 25 minute run again, unchanged. Repeated timeouts mean the
 * issue is too large for one phase, so say that and stop.
 *
 * Returns true when the caller should stop handling this phase.
 */
async function handleTimeout(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  timedOut: boolean,
  phaseName: string,
  log: Logger,
): Promise<boolean> {
  if (!timedOut) return false;

  state.timeouts += 1;
  writeState(state);
  const budget = cfg.phaseTimeoutMinutes ?? 25;

  if (state.timeouts >= (cfg.budget.maxTimeouts ?? 2)) {
    await pause(
      state,
      gh,
      cfg,
      `I've run out of time during ${phaseName} ${state.timeouts} times in a row (${budget} minutes each), so I'm stopping rather than burning another run on the same thing.\n\n` +
        `This usually means the issue is too big for one pass. Splitting it into smaller issues would let me finish, or raise \`phaseTimeoutMinutes\` if it's genuinely just long.`,
      log,
    );
    return true;
  }

  await block(
    state,
    gh,
    cfg,
    `I ran out of time during ${phaseName} after ${budget} minutes, so I have nothing I'd trust to show you.\n\n` +
      `I'll try once more if you reply, but if this issue covers a lot of ground it may be worth splitting up. ` +
      `Narrowing the scope in a comment would also help.`,
    log,
  );
  return true;
}

/**
 * Put the PR in a human's review queue.
 *
 * Review is requested from the configured reviewers, falling back to whoever
 * filed the issue. Reviewers are deliberately not assigned: assignment means
 * "responsible for the work" and the agent owns that, while review request
 * means "your input is wanted", which is the accurate ask.
 */
async function requestHumanReview(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  issueAuthor: string,
  log: Logger,
): Promise<void> {
  if (cfg.dryRun || !state.prNumber) return;
  const wanted = cfg.reviewers?.length ? cfg.reviewers : [issueAuthor];
  try {
    const reviewers = await gh.canReview(state.repo, wanted);
    if (reviewers.length === 0) {
      log(`no eligible reviewers among ${wanted.join(", ")}`);
      return;
    }
    await gh.requestReview(state.repo, state.prNumber, reviewers);
    state.reviewRequestedFrom = reviewers;
    writeState(state);
    log(`requested review from ${reviewers.join(", ")} on PR #${state.prNumber}`);
  } catch (e) {
    log(`review request failed: ${(e as Error).message}`);
  }
}

/**
 * File the agent's proposed follow-up issues.
 *
 * The agent has no credentials, so without this it either scope-creeps into
 * fixing unrelated problems or buries them in a docs file. Filed issues are
 * deliberately unlabelled: applying the watched label would let the agent
 * queue its own work forever.
 *
 * Best effort. A failure here must never affect the change under review.
 */
async function fileFollowUps(
  state: IssueState,
  cfg: Config,
  gh: GitHub,
  verdict: Verdict,
  log: Logger,
): Promise<void> {
  if (verdict.followUps.length === 0) return;

  // Cap per issue across all phases, not just per run.
  const remaining = 3 - state.followUpsFiled.length;
  if (remaining <= 0) {
    log(`follow-up cap reached for ${state.repo}#${state.issue}, skipping`);
    return;
  }

  for (const f of verdict.followUps.slice(0, remaining)) {
    const fingerprint = f.title.toLowerCase().trim();
    if (state.followUpsFiled.includes(fingerprint)) continue;

    if (cfg.dryRun) {
      log(`[dry-run] would file follow-up: ${f.title}`);
      state.followUpsFiled.push(fingerprint);
      continue;
    }

    try {
      const existing = await gh.findOpenIssueByTitle(state.repo, f.title);
      if (existing !== undefined) {
        log(`follow-up already open as #${existing}, not refiling`);
        state.followUpsFiled.push(fingerprint);
        continue;
      }
      const origin = state.prNumber
        ? `#${state.issue} (via #${state.prNumber})`
        : `#${state.issue}`;
      const created = await gh.createIssue(
        state.repo,
        f.title,
        `${f.body}\n\n<sub>Noticed by the issue agent while working on ${origin}, and left alone as out of scope. Unlabelled on purpose: label it if you want it picked up.</sub>`,
      );
      if (created) {
        state.followUpsFiled.push(fingerprint);
        log(`filed follow-up #${created.number}: ${f.title}`);
      }
    } catch (e) {
      log(`could not file follow-up "${f.title}": ${(e as Error).message}`);
    }
  }
  writeState(state);
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
  state.statusLabel = null;
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
      const { verdict, timedOut } = await runPi(
        planningPrompt(issue, thread),
        state,
        cfg,
        gh,
        log,
      );

      if (await handleTimeout(state, cfg, gh, timedOut, "planning", log)) return;

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
      state.timeouts = 0;

      state.note = verdict.summary;
      state.phase = "implementing";
      writeState(state);
      // The plan is real content, so it gets its own durable comment rather
      // than being folded into the mutable status comment. Prefer the
      // formatted plan; summary is the long internal record and reads badly
      // on an issue.
      if (!cfg.dryRun) {
        const plan = verdict.plan ?? truncate(verdict.summary, 900);
        await gh.comment(
          state.repo,
          state.issue,
          [
            `**Plan** (confidence ${verdict.confidence.toFixed(2)})`,
            plan,
            `Starting work now.${SIG}`,
          ].join("\n\n"),
        );
      }
      await publishStatus(state, cfg, gh, log);
      return;
    }

    case "implementing": {
      const wt = await ensureWorktree(state, cfg, gh, log);
      await publishStatus(state, cfg, gh, log);
      const plan = state.note ?? "(plan unavailable, re-derive from the issue)";
      const { verdict, timedOut } = await runPi(
        implementPrompt(issue, plan),
        state,
        cfg,
        gh,
        log,
      );

      if (await handleTimeout(state, cfg, gh, timedOut, "implementation", log)) return;
      state.timeouts = 0;

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
      if (verdict.prTitle) state.prTitle = verdict.prTitle;
      if (verdict.prBody) state.prBody = verdict.prBody;
      if (verdict.prTitle || verdict.prBody) writeState(state);
      await fileFollowUps(state, cfg, gh, verdict, log);

      // Subject describes what was built, not what was requested. The agent
      // sometimes deviates for good reason (a better API name than the issue
      // proposed), and prTitle reflects the change while issue.title reflects
      // the ask. Using the ask produces commits advertising APIs that aren't
      // in the diff.
      const subject = state.prTitle ?? issue.title;
      const committed = await commitAll(
        wt,
        `${subject}\n\n${state.prBody ? `${state.prBody}\n\n` : ""}Closes #${issue.number}`,
      );
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

      await push(state, gh, cfg, log, "implementation");
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
      await push(state, gh, cfg, log, "implementation");
      const base = await gh.defaultBranch(state.repo);
      // Body carries why; the diff already shows what. state.note is the long
      // internal record and deliberately does not go in here.
      const pr = await gh.createPr(state.repo, {
        title: state.prTitle ?? issue.title,
        body: [
          state.prBody ?? "",
          `Closes #${issue.number}`,
          `<sub>Opened by the issue agent. Review comments get a reply and a new commit, never a force-push.</sub>`,
        ]
          .filter(Boolean)
          .join("\n\n"),
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
      await requestHumanReview(state, cfg, gh, issue.user.login, log);
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

      // Never run the model on an empty prompt.
      //
      // A bare approval, or a review whose points were all answered in an
      // earlier round, leaves nothing to render. The agent then correctly
      // reports that it was given no feedback, and blocks on a question no
      // human can act on, which also stops conflict handling from ever
      // running again for that PR.
      const bots = await gh.botLogins();
      const substantive = reviews.filter(
        (r) => !bots.includes(r.user.login) && (r.body ?? "").trim().length > 0,
      );
      const inlineToAnswer = comments.filter((c) => !bots.includes(c.user.login));

      const conversation = state.pendingComments;

      if (substantive.length === 0 && inlineToAnswer.length === 0 && conversation.length === 0) {
        state.handledReviewIds.push(...reviews.map((r) => r.id));
        state.handledReviewCommentIds.push(...comments.map((c) => c.id));
        const approval = reviews.find((r) => r.state === "APPROVED");
        if (approval) state.approvedBy = approval.user.login;
        state.phase = "awaiting_review";
        writeState(state);
        await publishStatus(state, cfg, gh, log);
        log(
          `${state.repo}#${state.issue}: review round had no actionable content, not running the model`,
        );
        return;
      }

      const { verdict } = await runPi(
        reviewResponsePrompt(issue, substantive, inlineToAnswer, conversation),
        state,
        cfg,
        gh,
        log,
      );

      // A failed run has no answer in it. Its summary describes the harness's
      // own problem, and posting that as a reply tells someone who asked a real
      // question that their answer is "no verdict block".
      //
      // Throwing leaves the phase on responding with the comments still queued,
      // so the next cycle retries. Three identical failures then pause the
      // issue through the daemon's existing budget, which reports the real
      // error instead of dressing it up as a reply.
      if (verdict.status === "failed") {
        throw new Error(`review round produced no usable result: ${verdict.summary}`);
      }

      // Consumed; don't replay them on a later round.
      state.pendingComments = [];

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
      if (committed) await push(state, gh, cfg, log, "review feedback");

      if (!cfg.dryRun) {
        // Answer inside the reviewer's own thread. A detached top-level
        // comment loses the line context that made the point legible.
        const answered = new Set<number>();
        for (const reply of verdict.replies) {
          const target = comments.find((c) => c.id === reply.commentId);
          if (!target) continue;
          // Replies must attach to the thread root, not to another reply.
          const root = target.in_reply_to_id ?? target.id;
          try {
            await gh.replyToReviewComment(state.repo, prNumber, root, reply.body);
            answered.add(reply.commentId);
          } catch (e) {
            log(`inline reply to ${reply.commentId} failed: ${(e as Error).message}`);
          }
        }
        if (answered.size > 0) {
          log(`replied inline to ${answered.size} comment(s) on PR #${prNumber}`);
        }

        // Fall back to a PR-level comment when there was nothing to reply to
        // inline, which is also how a conversation comment gets an answer.
        if (answered.size === 0) {
          // summary is the internal record and reads like one. Prefer the
          // field written to the person; fall back to an inline reply's text
          // only if the model left reply null.
          const fallback =
            verdict.reply ??
            verdict.replies[0]?.body ??
            truncate(stripVerdict(verdict.summary), 600);

          // Answer where the question was asked. An issue comment answered on
          // the pull request reads as an unprompted change, because the reader
          // is not looking at the thing it replies to.
          const askedOnIssue = conversation.some((c) => c.source === "issue");
          const target = askedOnIssue ? state.issue : prNumber;
          const answering = conversation.find((c) => c.url)?.url;
          const attribution = answering ? `Replying to ${answering}\n\n` : "";

          await gh.comment(
            state.repo,
            target,
            `${attribution}${fallback}${committed ? "" : "\n\nNo code changes were needed this round."}${SIG}`,
          );
        }
      }

      await fileFollowUps(state, cfg, gh, verdict, log);
      state.phase = "awaiting_review";
      state.note = null;
      writeState(state);
      await publishStatus(state, cfg, gh, log);
      log(`answered review round ${state.reviewRounds} on PR #${prNumber}`);
      return;
    }

    case "merging": {
      const wt = await ensureWorktree(state, cfg, gh, log);
      const base = await gh.defaultBranch(state.repo);
      state.mergeAttempts += 1;
      writeState(state);

      await publishStatus(
        state,
        cfg,
        gh,
        log,
        `Merging \`origin/${base}\` into \`${state.branch}\` (attempt ${state.mergeAttempts}). ` +
          `Merging rather than rebasing, so your inline comments stay anchored.`,
      );

      // Merge rather than rebase: rebasing rewrites history and needs a force
      // push, which would orphan inline comments and reset "viewed" markers.
      const clone = repoCachePath(state.repo);
      await gitAuthed(state.repo, gh, ["fetch", "--quiet", "origin", base], { cwd: clone });
      const merge = await exec("git", ["merge", "--no-edit", `origin/${base}`], { cwd: wt });

      if (merge.code === 0) {
        await push(state, gh, cfg, log, "merge with base");
        state.phase = "awaiting_review";
        state.mergeAttempts = 0;
        writeState(state);
        await publishStatus(
          state,
          cfg,
          gh,
          log,
          `Merged \`origin/${base}\` in cleanly, no conflicts.`,
        );
        log(`merged ${base} into ${state.branch} cleanly`);
        return;
      }

      const conflicted = (
        await exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: wt })
      ).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      if (conflicted.length === 0) {
        // Merge failed for some reason other than conflicts; don't leave the
        // tree half-merged.
        await exec("git", ["merge", "--abort"], { cwd: wt });
        await block(
          state,
          gh,
          cfg,
          `I couldn't merge \`${base}\` into this branch and it wasn't a content conflict:\n\n\`\`\`\n${scrub(merge.stderr).slice(0, 600)}\n\`\`\``,
          log,
        );
        return;
      }

      log(`${conflicted.length} conflicted file(s): ${conflicted.join(", ")}`);
      const baseLog = (
        await exec("git", ["log", "--oneline", `HEAD..origin/${base}`], { cwd: wt })
      ).stdout;

      const { verdict, timedOut } = await runPi(
        conflictPrompt(issue, base, conflicted, baseLog),
        state,
        cfg,
        gh,
        log,
      );

      if (timedOut || verdict.status !== "ok") {
        await exec("git", ["merge", "--abort"], { cwd: wt });
        await block(
          state,
          gh,
          cfg,
          `I couldn't resolve the conflicts with \`${base}\` myself.\n\n${verdict.summary}\n\nConflicted files:\n${conflicted.map((f) => `- \`${f}\``).join("\n")}`,
          log,
        );
        return;
      }

      // Judge the resolution by file contents, not by index state.
      //
      // The agent is forbidden from running git, so it can only edit the
      // working tree; the index keeps listing every path as unmerged no matter
      // how well it resolved. Checking --diff-filter=U here threw away good
      // work every single time.
      const unresolved = conflicted.filter((f) => {
        try {
          return /^(<{7}|>{7})/m.test(fs.readFileSync(path.join(wt, f), "utf-8"));
        } catch {
          // Deleted by the resolution (a legitimate outcome) is not a failure.
          return false;
        }
      });

      if (unresolved.length > 0) {
        await exec("git", ["merge", "--abort"], { cwd: wt });
        await block(
          state,
          gh,
          cfg,
          `I tried to resolve the merge with \`${base}\` but left conflict markers in:\n${unresolved
            .map((f) => `- \`${f}\``)
            .join("\n")}`,
          log,
        );
        return;
      }

      // Staging is what actually marks the conflicted paths resolved.
      await exec("git", ["add", "-A"], { cwd: wt });
      const stillUnmerged = (
        await exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: wt })
      ).stdout.trim();
      if (stillUnmerged) {
        await exec("git", ["merge", "--abort"], { cwd: wt });
        await block(
          state,
          gh,
          cfg,
          `Git still reports unmerged paths after staging the resolution:\n${stillUnmerged
            .split("\n")
            .map((f) => `- \`${f}\``)
            .join("\n")}`,
          log,
        );
        return;
      }
      const commit = await exec("git", ["commit", "--no-edit"], { cwd: wt });
      if (commit.code !== 0) {
        await block(state, gh, cfg, `Couldn't finish the merge commit: ${scrub(commit.stderr)}`, log);
        return;
      }
      await push(state, gh, cfg, log, "conflict resolution");
      state.phase = "awaiting_review";
      state.mergeAttempts = 0;
      writeState(state);
      await publishStatus(state, cfg, gh, log);
      if (!cfg.dryRun) {
        await gh.comment(
          state.repo,
          state.prNumber as number,
          `Merged \`${base}\` in and resolved the conflicts.\n\n${truncate(verdict.summary, 500)}${SIG}`,
        );
      }
      log(`resolved ${conflicted.length} conflict(s) with ${base}`);
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
        await push(state, gh, cfg, log, "CI fix");
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
