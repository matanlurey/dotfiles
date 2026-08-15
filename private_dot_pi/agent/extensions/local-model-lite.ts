/**
 * Local model lite mode
 *
 * Ollama models (Gemma 4, etc.) pay for every registered extension tool
 * schema on every turn, and a cold cache miss means that whole payload
 * gets reprocessed before the first token. Cloud models don't feel this
 * the same way because their providers cache the system prompt/tool
 * prefix server-side.
 *
 * When the active model is served by the "ollama" provider, drop down to
 * just the built-in tools (read, bash, edit, write, grep, find, ls) plus
 * anything registered by pi-mcp-adapter — its default proxy pattern
 * exposes one `mcp` gateway tool (~200 tokens) regardless of how many MCP
 * servers/tools are configured behind it, so keeping it active is cheap
 * and lets local models still drive MCP tools (e.g. game servers). Every
 * other extension's tools (pi-tasks, pi-goal, pi-subagents, pi-web-access,
 * etc.) are dropped. Switching back to a cloud model restores the full
 * tool set automatically — no separate alias or flag needed, `pi` just
 * works either way.
 */

import type { ExtensionAPI, Model, ToolInfo } from "@earendil-works/pi-coding-agent";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function isLocalModel(model: Model<any> | undefined): boolean {
  return model?.provider === "ollama";
}

function isMcpTool(tool: ToolInfo): boolean {
  const source = tool.sourceInfo?.source ?? "";
  const path = tool.sourceInfo?.path ?? "";
  return (
    tool.name === "mcp" ||
    source.toLowerCase().includes("pi-mcp-adapter") ||
    path.toLowerCase().includes("pi-mcp-adapter")
  );
}

export default function localModelLite(pi: ExtensionAPI) {
  function applyForModel(model: Model<any> | undefined) {
    const all = pi.getAllTools();
    if (isLocalModel(model)) {
      const keep = new Set([...BUILTIN_TOOLS, ...all.filter(isMcpTool).map((t) => t.name)]);
      pi.setActiveTools([...keep]);
    } else {
      pi.setActiveTools(all.map((tool) => tool.name));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    applyForModel(ctx.model);
  });

  pi.on("model_select", async (event) => {
    applyForModel(event.model);
  });
}
