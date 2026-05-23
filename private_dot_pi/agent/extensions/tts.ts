/**
 * Text-to-speech via macOS `say`.
 *
 * /speak       - read the last assistant message aloud
 * /speak stop  - stop speaking
 * /speak auto  - toggle auto-speak for every assistant message
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, type ChildProcess } from "node:child_process";

export default function tts(pi: ExtensionAPI) {
  let autoSpeak = false;
  let currentProcess: ChildProcess | null = null;

  function stopSpeaking() {
    if (currentProcess) {
      currentProcess.kill();
      currentProcess = null;
    }
  }

  function speak(text: string) {
    stopSpeaking();
    // Strip markdown formatting for cleaner speech
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block omitted ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#*_~>]/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .trim();

    if (!clean) return;

    currentProcess = execFile("say", [clean], (err) => {
      currentProcess = null;
    });
  }

  function getLastAssistantText(ctx: { sessionManager: { getEntries(): any[] } }): string | null {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const content = entry.message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }
      }
    }
    return null;
  }

  pi.registerCommand("speak", {
    description: "Text-to-speech: /speak, /speak stop, /speak auto",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      if (arg === "stop") {
        stopSpeaking();
        ctx.ui.notify("Stopped speaking", "info");
        return;
      }

      if (arg === "auto") {
        autoSpeak = !autoSpeak;
        ctx.ui.notify(`Auto-speak ${autoSpeak ? "on" : "off"}`, "info");
        return;
      }

      const text = getLastAssistantText(ctx);
      if (text) {
        speak(text);
      } else {
        ctx.ui.notify("No assistant message to speak", "info");
      }
    },
  });

  pi.on("message_end", async (event, _ctx) => {
    if (!autoSpeak) return;
    if (event.message.role !== "assistant") return;

    const content = event.message.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    } else {
      return;
    }

    if (text) speak(text);
  });

  pi.on("session_shutdown", async () => {
    stopSpeaking();
  });
}
