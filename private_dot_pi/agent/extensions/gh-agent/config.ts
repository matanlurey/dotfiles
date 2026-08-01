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
  /** How many review rounds to answer before requiring a human. */
  maxReviewRounds: number;
  /** Spend ceiling per issue. Zero disables the check. */
  maxUsdPerIssue: number;
};

export type Config = {
  appId: string;
  privateKeyPath: string;
  /** Issue label that opts an issue into autonomous work. */
  label: string;
  pollIntervalSeconds: number;
  maxConcurrentIssues: number;
  /**
   * Repo allowlist as "owner/name". Empty means every repo the App is
   * installed on, which is already a GitHub-enforced allowlist.
   */
  repos: string[];
  /** Model passed to headless pi runs. */
  model: string;
  thinking: string;
  budget: Budget;
  /** Plan and report actions without writing to GitHub or pushing. */
  dryRun: boolean;
  /** Branch prefix for bot PRs. Never push to a default branch. */
  branchPrefix: string;
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

const DEFAULTS: Omit<Config, "appId"> = {
  privateKeyPath: path.join(ROOT, "private-key.pem"),
  label: "good for agent",
  pollIntervalSeconds: 60,
  maxConcurrentIssues: 3,
  repos: [],
  model: "anthropic/claude-sonnet-5",
  thinking: "medium",
  budget: {
    maxTurnsPerPhase: 40,
    maxCiFixAttempts: 3,
    maxReviewRounds: 10,
    maxUsdPerIssue: 5,
  },
  dryRun: false,
  branchPrefix: "agent/",
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

  let raw: Partial<Config>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
  } catch (e) {
    throw new ConfigError(`Config at ${CONFIG_PATH} is not valid JSON: ${(e as Error).message}`);
  }

  if (!raw.appId) {
    throw new ConfigError(
      `Config is missing "appId". Find it at https://github.com/settings/apps/matanlurey-agent (App ID, near the top).`,
    );
  }

  const cfg: Config = {
    ...DEFAULTS,
    ...raw,
    appId: String(raw.appId),
    budget: { ...DEFAULTS.budget, ...(raw.budget ?? {}) },
    privateKeyPath: expandHome(raw.privateKeyPath ?? DEFAULTS.privateKeyPath),
  };

  if (!fs.existsSync(cfg.privateKeyPath)) {
    throw new ConfigError(
      `Private key not found at ${cfg.privateKeyPath}. Generate one on the App settings page and save it there (chmod 600).`,
    );
  }

  // A private key readable by other users is a credential leak; refuse to run.
  const mode = fs.statSync(cfg.privateKeyPath).mode & 0o077;
  if (mode !== 0) {
    throw new ConfigError(
      `Private key at ${cfg.privateKeyPath} is group/world readable. Run: chmod 600 ${cfg.privateKeyPath}`,
    );
  }

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

export function writeConfig(partial: Partial<Config> & { appId: string }): Config {
  ensureDirs();
  const merged = { ...DEFAULTS, ...partial };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged as Config;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}
