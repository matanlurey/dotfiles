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

export default function ghAgent(pi: ExtensionAPI) {
  // A worker's own nested pi run must not spawn another watcher.
  if (process.env.PI_GH_AGENT === "1") return;

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
    description: "Autonomous GitHub issue worker: setup | start | stop | status | once | logs",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      try {
        switch (sub) {
          case "setup": {
            ensureDirs();
            const appId = await ctx.ui.input(
              "GitHub App ID",
              "Find it at github.com/settings/apps/matanlurey-agent",
            );
            if (!appId) return;

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
              appId: appId.trim(),
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
              `I configured the GitHub issue agent:\n\n- App ID: ${cfg.appId}\n- Label: "${cfg.label}"\n- Repos: ${cfg.repos.length ? cfg.repos.join(", ") : "(all installed)"}\n- Max concurrent: ${cfg.maxConcurrentIssues}\n- Dry run: ${cfg.dryRun}\n\nConfig is at ${CONFIG_PATH}. Verify the App is installed on those repos, then run \`/gh-agent once\` to test a single cycle.`,
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
                    return `Label "${c.label}", ${c.repos.length ? c.repos.join(", ") : "all installed repos"}${c.dryRun ? ", DRY RUN" : ""}.`;
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
