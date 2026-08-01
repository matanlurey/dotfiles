/**
 * GitHub issue agent: watches a label, works issues autonomously, opens PRs,
 * answers reviews, and stands down when the work merges or the label goes away.
 *
 * This file is only the control surface. The actual work happens in a detached
 * daemon (daemon.ts) so it keeps running after the pi session closes.
 *
 *   /gh-agent setup    configure the App and repos
 *   /gh-agent start    launch the daemon in the background
 *   /gh-agent stop     stop it
 *   /gh-agent status   what every tracked issue is doing
 *   /gh-agent once     run a single reconcile cycle in the foreground
 *   /gh-agent logs     tail the daemon log
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  configExists,
  DAEMON_LOG,
  DAEMON_PID_FILE,
  ensureDirs,
  loadConfig,
  ROOT,
  writeConfig,
} from "./config.ts";

import { allStates, type IssueState } from "./state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "daemon.ts");

function daemonPid(): number | undefined {
  if (!fs.existsSync(DAEMON_PID_FILE)) return undefined;
  const pid = Number(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim());
  if (!Number.isFinite(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Stale pid file from a crashed or killed daemon.
    fs.rmSync(DAEMON_PID_FILE, { force: true });
    return undefined;
  }
}

const PHASE_ICON: Record<string, string> = {
  claimed: "•",
  planning: "◔",
  implementing: "◑",
  pr_open: "◕",
  awaiting_review: "○",
  responding: "◑",
  ci_fixing: "◑",
  blocked: "?",
  paused: "‖",
  done: "✓",
  abandoned: "×",
};

function summarize(states: IssueState[]): string[] {
  if (states.length === 0) return ["No issues tracked."];
  return states.map((s) => {
    const icon = PHASE_ICON[s.phase] ?? "•";
    const pr = s.prNumber ? ` PR#${s.prNumber}` : "";
    const note = s.note ? ` — ${s.note.split("\n")[0].slice(0, 60)}` : "";
    return `${icon} ${s.repo}#${s.issue} [${s.phase}]${pr}${note}`;
  });
}

/**
 * Commands a worker run must never execute.
 *
 * Credentials are already stripped from the child environment, but a blocked
 * tool call fails loudly with an explanation instead of failing obscurely deep
 * inside a shell pipeline, and it covers anything the agent might find that
 * still holds a token.
 */
function forbiddenForWorker(command: string): string | undefined {
  const parts = command
    .split(/&&|\|\||;|\|/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const cmd of parts) {
    if (/^(sudo\s+)?gh\b/.test(cmd)) {
      return (
        "The `gh` CLI is not available to you. Every GitHub action (opening or " +
        "retitling a PR, commenting, merging, labelling) is performed by the " +
        "harness as the app's bot user, not by you as the repo owner. " +
        "If a GitHub-side change is needed, describe it in your verdict " +
        "summary, or set prTitle for a pull request title, and the harness " +
        "will apply it."
      );
    }
    if (/^(sudo\s+)?git\s+(push|commit|merge|rebase|reset|tag|remote)\b/.test(cmd)) {
      return (
        "The harness owns all git mutations. Leave your work uncommitted in the " +
        "working tree; it is committed and pushed for you, as a new commit so " +
        "reviewers keep their context. Read-only git (status, diff, log, show) " +
        "is fine."
      );
    }
    if (/^(sudo\s+)?jj\s+(git|push|describe|commit|new|squash|abandon|edit)\b/.test(cmd)) {
      return (
        "This is a plain git worktree with no jj workspace, and the harness " +
        "owns all version control mutations anyway. Just edit files."
      );
    }
  }
  return undefined;
}

export default function ghAgent(pi: ExtensionAPI) {
  // Inside a worker run: install guardrails only, never the control surface.
  if (process.env.PI_GH_AGENT === "1") {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") return;
      const command = (event.input as { command?: string }).command;
      if (!command) return;
      const reason = forbiddenForWorker(command);
      if (reason) return { block: true, reason };
    });
    return;
  }

  function refreshStatus(ctx: { ui: { setStatus(k: string, v: string | undefined): void } }) {
    const pid = daemonPid();
    if (!pid) {
      ctx.ui.setStatus("gh-agent", undefined);
      return;
    }
    const active = allStates().filter(
      (s) => s.phase !== "done" && s.phase !== "abandoned",
    );
    const blocked = active.filter((s) => s.phase === "blocked" || s.phase === "paused").length;
    ctx.ui.setStatus(
      "gh-agent",
      `agent ${active.length}${blocked > 0 ? ` (${blocked} need you)` : ""}`,
    );
  }

  pi.on("session_start", async (_e, ctx) => {
    if (configExists()) refreshStatus(ctx);
  });

  pi.registerCommand("gh-agent", {
    description:
      "Autonomous GitHub issue worker: setup | add-app | start | stop | status | once | logs",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      try {
        switch (sub) {
          case "setup": {
            ensureDirs();
            const appId = await ctx.ui.input(
              "GitHub App ID",
              "The numeric App ID from the App's settings page",
            );
            if (!appId) return;

            const keyPath = await ctx.ui.input(
              "Private key path",
              path.join(ROOT, "private-key.pem"),
            );

            const label = (await ctx.ui.input("Issue label to watch", "good for agent")) ||
              "good for agent";
            const reposRaw = await ctx.ui.input(
              "Repo allowlist (comma separated, blank = every repo the App can see)",
              "owner/name, owner/other",
            );
            const concurrency = await ctx.ui.input("Max concurrent issues", "3");
            const dryRun = await ctx.ui.confirm(
              "Start in dry-run mode?",
              "Dry run plans and logs everything but never comments, pushes, or opens PRs. Recommended for the first run.",
            );

            const cfg = writeConfig({
              apps: [
                {
                  appId: appId.trim(),
                  privateKeyPath: (keyPath || path.join(ROOT, "private-key.pem")).trim(),
                },
              ],
              label: label.trim(),
              repos: (reposRaw ?? "")
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
              maxConcurrentIssues: Number(concurrency) || 3,
              dryRun,
            });

            ctx.ui.notify(`Wrote ${CONFIG_PATH}`, "info");
            pi.sendUserMessage(
              `I configured the GitHub issue agent:\n\n- Apps: ${cfg.apps.map((a) => a.appId).join(", ")}\n- Label: "${cfg.label}"\n- Repos: ${cfg.repos.length ? cfg.repos.join(", ") : "(all installed)"}\n- Max concurrent: ${cfg.maxConcurrentIssues}\n- Dry run: ${cfg.dryRun}\n\nConfig is at ${CONFIG_PATH}. Verify the App is installed on those repos, then run \`/gh-agent once\` to test a single cycle.`,
            );
            return;
          }

          case "add-app": {
            // A private App only installs on the account that owns it, so
            // covering a personal account plus an org needs one App per account.
            if (!configExists()) {
              ctx.ui.notify("No config yet. Run /gh-agent setup first.", "error");
              return;
            }
            const current = loadConfig();
            const appId = await ctx.ui.input("Additional GitHub App ID", "e.g. 4460000");
            if (!appId) return;
            const keyPath = await ctx.ui.input(
              "Private key path for that App",
              path.join(ROOT, `${appId.trim()}.pem`),
            );
            if (!keyPath) return;

            const updated = writeConfig({
              ...current,
              apps: [
                ...current.apps,
                { appId: appId.trim(), privateKeyPath: keyPath.trim() },
              ],
            });
            ctx.ui.notify(`Now using ${updated.apps.length} Apps.`, "info");
            pi.sendUserMessage(
              `Added App ${appId.trim()} to the issue agent config. Apps are now: ${updated.apps.map((a) => a.appId).join(", ")}. Run \`/gh-agent once\` to confirm both authenticate and which repos each can reach.`,
            );
            return;
          }

          case "start": {
            if (!configExists()) {
              ctx.ui.notify("No config yet. Run /gh-agent setup first.", "error");
              return;
            }
            const existing = daemonPid();
            if (existing) {
              ctx.ui.notify(`Already running (pid ${existing}).`, "warning");
              return;
            }
            loadConfig(); // Surface config errors here rather than in the daemon log.
            ensureDirs();

            const out = fs.openSync(DAEMON_LOG, "a");
            const child = spawn(process.execPath, [DAEMON], {
              detached: true,
              stdio: ["ignore", out, out],
              env: { ...process.env, PI_GH_AGENT_DAEMON: "1" },
            });
            child.unref();
            ctx.ui.notify(`Daemon started (pid ${child.pid}).`, "info");
            refreshStatus(ctx);
            return;
          }

          case "stop": {
            const pid = daemonPid();
            if (!pid) {
              ctx.ui.notify("Not running.", "warning");
              return;
            }
            process.kill(pid, "SIGTERM");
            fs.rmSync(DAEMON_PID_FILE, { force: true });
            ctx.ui.notify(`Stopped (pid ${pid}).`, "info");
            ctx.ui.setStatus("gh-agent", undefined);
            return;
          }

          case "once": {
            if (!configExists()) {
              ctx.ui.notify("No config yet. Run /gh-agent setup first.", "error");
              return;
            }
            ctx.ui.notify("Running one cycle...", "info");
            const res = await pi.exec(process.execPath, [DAEMON, "--once"], {
              timeout: 30 * 60 * 1000,
            });
            pi.sendUserMessage(
              `One reconcile cycle finished (exit ${res.code}). Output:\n\n\`\`\`\n${(res.stdout + res.stderr).slice(-4000)}\n\`\`\`\n\nSummarize what happened and whether anything needs my attention.`,
            );
            refreshStatus(ctx);
            return;
          }

          case "logs": {
            const n = Number(rest[0]) || 40;
            if (!fs.existsSync(DAEMON_LOG)) {
              ctx.ui.notify("No log yet.", "warning");
              return;
            }
            const lines = fs.readFileSync(DAEMON_LOG, "utf-8").trimEnd().split("\n");
            pi.sendUserMessage(
              `Last ${n} lines of the gh-agent daemon log:\n\n\`\`\`\n${lines.slice(-n).join("\n")}\n\`\`\``,
            );
            return;
          }

          case "status":
          default: {
            const pid = daemonPid();
            const states = allStates().filter(
              (s) => s.phase !== "done" && s.phase !== "abandoned",
            );
            const header = pid ? `Daemon running (pid ${pid}).` : "Daemon stopped.";
            const cfgLine = configExists()
              ? (() => {
                  try {
                    const c = loadConfig();
                    return `${c.apps.length} App(s): ${c.apps.map((a) => a.appId).join(", ")}. Label "${c.label}", ${c.repos.length ? c.repos.join(", ") : "all installed repos"}${c.dryRun ? ", DRY RUN" : ""}.`;
                  } catch (e) {
                    return `Config problem: ${(e as Error).message}`;
                  }
                })()
              : "Not configured. Run /gh-agent setup.";

            ctx.ui.notify(`${header} ${states.length} active.`, "info");
            pi.sendUserMessage(
              `GitHub issue agent status.\n\n${header}\n${cfgLine}\nState dir: ${ROOT}\n\n${summarize(states).join("\n")}\n\nIf anything is blocked or paused, tell me what it's waiting on.`,
            );
            refreshStatus(ctx);
            return;
          }
        }
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
      }
    },
  });
}
