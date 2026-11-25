import { isReasoning } from "./config.js";
import type { Reasoning } from "./types.js";

export type Command =
  | { type: "help" }
  | { type: "agents" }
  | { type: "status" }
  | { type: "board" }
  | { type: "ask"; agentId: string; text: string }
  | { type: "team"; text: string }
  | { type: "auto"; text: string }
  | { type: "model"; agentId: string; model: string }
  | { type: "reasoning"; agentId: string; reasoning: Reasoning }
  | { type: "lead"; agentId: string }
  | { type: "error"; message: string };

export interface AgentRef {
  id: string;
  name: string;
}

const TEAM_WORDS = new Set(["team", "all", "everyone", "crew"]);

export function resolveAgent(token: string, agents: AgentRef[]): string | null {
  const t = token.toLowerCase().replace(/^@/, "");
  const hit = agents.find((a) => a.id === t || a.name.toLowerCase() === t);
  return hit ? hit.id : null;
}

/**
 * Parse a message from any channel into a command.
 * Examples: "@grok what's trending", "@team launch plan", "/model grok grok-4",
 * "/reasoning hermes high", "/agents", or plain text (auto-routed).
 */
export function parseCommand(input: string, agents: AgentRef[]): Command {
  // Telegram group commands look like /status@MyBot; drop the bot suffix.
  const text = input.trim().replace(/^(\/\w+)@\w+/, "$1");
  if (!text) return { type: "error", message: "Empty message." };

  if (text.startsWith("/")) {
    const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const args = rest.filter(Boolean);
    switch (cmd) {
      case "start":
      case "help":
        return { type: "help" };
      case "agents":
      case "crew":
        return { type: "agents" };
      case "status":
        return { type: "status" };
      case "board":
      case "leaderboard":
        return { type: "board" };
      case "team": {
        const goal = text.slice(rawCmd.length + 1).trim();
        return goal ? { type: "team", text: goal } : { type: "error", message: "Usage: /team <goal>" };
      }
      case "model": {
        const agentId = args[0] ? resolveAgent(args[0], agents) : null;
        if (!agentId || !args[1]) return { type: "error", message: "Usage: /model <agent> <model-id>" };
        return { type: "model", agentId, model: args[1] };
      }
      case "reasoning":
      case "think": {
        const agentId = args[0] ? resolveAgent(args[0], agents) : null;
        const level = args[1]?.toLowerCase();
        if (!agentId || !isReasoning(level)) {
          return { type: "error", message: "Usage: /reasoning <agent> off|low|medium|high|max" };
        }
        return { type: "reasoning", agentId, reasoning: level };
      }
      case "lead": {
        const agentId = args[0] ? resolveAgent(args[0], agents) : null;
        return agentId ? { type: "lead", agentId } : { type: "error", message: "Usage: /lead <agent>" };
      }
      default: {
        // Allow "/grok do this" as a shortcut for "@grok do this".
        const agentId = resolveAgent(cmd, agents);
        const body = text.slice(rawCmd.length + 1).trim();
        if (agentId && body) return { type: "ask", agentId, text: body };
        if (TEAM_WORDS.has(cmd) && body) return { type: "team", text: body };
        return { type: "error", message: `Unknown command /${cmd}. Try /help.` };
      }
    }
  }

  const mention = /^@([\w-]+)[\s,:]+([\s\S]+)$/.exec(text);
  if (mention) {
    const [, who, body] = mention;
    if (TEAM_WORDS.has(who.toLowerCase())) return { type: "team", text: body.trim() };
    const agentId = resolveAgent(who, agents);
    if (agentId) return { type: "ask", agentId, text: body.trim() };
    return { type: "error", message: `No agent called @${who}. Try /agents.` };
  }

  return { type: "auto", text };
}

/** Pick the agent whose skills best match the text. Ties go to the fallback (lead). */
export function pickAgent(
  text: string,
  agents: { id: string; skills: string[]; enabled: boolean }[],
  fallback: string,
): string {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  let best = fallback;
  let bestScore = 0;
  for (const agent of agents) {
    if (!agent.enabled) continue;
    const score = agent.skills.reduce((n, skill) => n + (words.has(skill) ? 1 : 0), 0);
    if (score > bestScore) {
      best = agent.id;
      bestScore = score;
    }
  }
  return best;
}

export const HELP_TEXT = [
  "Relay: one line to all your agents.",
  "",
  "@grok <ask>       talk to one agent",
  "@team <goal>      lead plans, crew splits the work",
  "<plain text>      auto-picks the best agent",
  "",
  "/agents           models, reasoning, usage",
  "/status           what's running now",
  "/board            who did the most work",
  "/model <agent> <model-id>",
  "/reasoning <agent> off|low|medium|high|max",
  "/lead <agent>     choose who plans team goals",
].join("\n");
