/**
 * Configuration + filesystem layout for the GitHub agent worker.
 *
 * Runtime data (config, private key, state, worktrees, logs) lives outside the
 * chezmoi source tree in ~/.pi/agent/gh-agent-worker so secrets are never
 * tracked. Only the code in this directory is version controlled.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Budget = {
  /** Hard cap on agent turns per phase. Exhaustion pauses the issue. */
  maxTurnsPerPhase: number;
  /** How many times to retry a red CI pipeline before giving up. */
  maxCiFixAttempts: number;
  /**
   * Consecutive phase timeouts before the agent stops instead of asking again.
   * A timeout is not a question a human can answer, so retrying it unchanged
   * just burns the budget again.
   */
  maxTimeouts: number;
  /** How many review rounds to answer before requiring a human. */
  maxReviewRounds: number;
  /** Spend ceiling per issue. Zero disables the check. */
  maxUsdPerIssue: number;
};

/**
 * One GitHub App's credentials.
 *
 * A private App can only be installed on the account that owns it, so covering
 * both a personal account and an org means one App per account.
 */
export type AppCred = {
  appId: string;
  privateKeyPath: string;
};

export type Config = {
  /** Normalized from either "apps" or a top-level appId/privateKeyPath pair. */
  apps: AppCred[];
  /** Issue label that opts an issue into autonomous work. */
  label: string;
  pollIntervalSeconds: number;
  maxConcurrentIssues: number;
  /**
   * Repo allowlist as "owner/name". Empty means every repo the App is
   * installed on, which is already a GitHub-enforced allowlist.
   */
  repos: string[];
  /** Default model for headless pi runs. */
  model: string;
  /**
   * Per-phase overrides, e.g. { "ci_fixing": "anthropic/claude-haiku-4-5" }.
   * Anything omitted uses `model`.
   */
  modelByPhase: Record<string, string>;
  /**
   * Model to retry with after a phase times out or fails.
   *
   * Retrying an identical run at the same tier reproduces the same failure, so
   * a struggling phase escalates instead. Empty disables escalation.
   */
  escalationModel: string;
  thinking: string;
  /** Thinking level used with escalationModel. */
  escalationThinking: string;
  budget: Budget;
  /** Plan and report actions without writing to GitHub or pushing. */
  dryRun: boolean;
  /** Branch prefix for bot PRs. Never push to a default branch. */
  branchPrefix: string;
  /**
   * Open pull requests as drafts.
   *
   * A draft doesn't request review, so nobody is pinged for a change that may
   * not even build. When checks go green the PR is promoted to ready
   * automatically. Set false if you'd rather see it in the review queue
   * immediately.
   */
  openPrAsDraft: boolean;
  /**
   * Who to request review from once a PR needs a human. They are asked to
   * review, not assigned: the agent stays responsible for the work.
   * Empty falls back to the issue's author.
   */
  reviewers: string[];
  /** Wall-clock ceiling for a single phase. The hard budget. */
  phaseTimeoutMinutes: number;
};

export const ROOT = path.join(os.homedir(), ".pi", "agent", "gh-agent-worker");
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const STATE_DIR = path.join(ROOT, "state");
export const WORKTREE_DIR = path.join(ROOT, "worktrees");
export const LOG_DIR = path.join(ROOT, "logs");
export const REPO_CACHE_DIR = path.join(ROOT, "repos");
export const DAEMON_PID_FILE = path.join(ROOT, "daemon.pid");
export const DAEMON_LOG = path.join(LOG_DIR, "daemon.log");
export const TOKEN_CACHE = path.join(ROOT, "token-cache.json");

const DEFAULTS: Omit<Config, "apps"> = {
  label: "good for agent",
  pollIntervalSeconds: 60,
  maxConcurrentIssues: 3,
  repos: [],
  model: "anthropic/claude-sonnet-5",
  modelByPhase: {},
  escalationModel: "anthropic/claude-opus-4-8",
  thinking: "medium",
  escalationThinking: "high",
  budget: {
    maxTurnsPerPhase: 40,
    maxCiFixAttempts: 3,
    maxReviewRounds: 10,
    maxUsdPerIssue: 5,
    maxTimeouts: 2,
  },
  dryRun: false,
  branchPrefix: "agent/",
  openPrAsDraft: true,
  reviewers: [],
  phaseTimeoutMinutes: 25,
};

export function ensureDirs(): void {
  for (const dir of [ROOT, STATE_DIR, WORKTREE_DIR, LOG_DIR, REPO_CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export class ConfigError extends Error {}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new ConfigError(
      `No config at ${CONFIG_PATH}. Run /gh-agent setup to create one.`,
    );
  }

  type RawConfig = Partial<Config> & { appId?: string; privateKeyPath?: string };
  let raw: RawConfig;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as RawConfig;
  } catch (e) {
    throw new ConfigError(`Config at ${CONFIG_PATH} is not valid JSON: ${(e as Error).message}`);
  }

  // Accept either the multi-App "apps" array or a single top-level pair.
  const rawApps: AppCred[] = raw.apps?.length
    ? raw.apps
    : raw.appId
      ? [
          {
            appId: raw.appId,
            privateKeyPath: raw.privateKeyPath ?? path.join(ROOT, "private-key.pem"),
          },
        ]
      : [];

  if (rawApps.length === 0) {
    throw new ConfigError(
      `Config declares no GitHub App. Add an "apps": [{ "appId": "...", "privateKeyPath": "..." }] entry. The App ID is near the top of the App's settings page.`,
    );
  }

  const apps = rawApps.map((a, i) => {
    if (!a.appId) throw new ConfigError(`apps[${i}] is missing "appId".`);
    const keyPath = expandHome(a.privateKeyPath ?? path.join(ROOT, "private-key.pem"));
    if (!fs.existsSync(keyPath)) {
      throw new ConfigError(
        `Private key for app ${a.appId} not found at ${keyPath}. Generate one on the App settings page and save it there (chmod 600).`,
      );
    }
    // A private key readable by other users is a credential leak; refuse to run.
    if ((fs.statSync(keyPath).mode & 0o077) !== 0) {
      throw new ConfigError(
        `Private key at ${keyPath} is group/world readable. Run: chmod 600 ${keyPath}`,
      );
    }
    return { appId: String(a.appId), privateKeyPath: keyPath };
  });

  const seen = new Set<string>();
  for (const a of apps) {
    if (seen.has(a.appId)) throw new ConfigError(`Duplicate appId ${a.appId} in "apps".`);
    seen.add(a.appId);
  }

  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    apps,
    budget: { ...DEFAULTS.budget, ...(raw.budget ?? {}) },
  };

  if (cfg.maxConcurrentIssues < 1) {
    throw new ConfigError(`maxConcurrentIssues must be >= 1, got ${cfg.maxConcurrentIssues}`);
  }
  if (cfg.pollIntervalSeconds < 10) {
    throw new ConfigError(
      `pollIntervalSeconds must be >= 10 to stay well inside GitHub rate limits, got ${cfg.pollIntervalSeconds}`,
    );
  }

  return cfg;
}

export function writeConfig(partial: Partial<Config> & { apps: AppCred[] }): Config {
  ensureDirs();
  const merged = { ...DEFAULTS, ...partial };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged as Config;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}
