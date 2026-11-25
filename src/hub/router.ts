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
  | { type: "approvals" }
  | { type: "inbox"; mode: "list" | "summary"; hours: number; unreadOnly: boolean; text?: string; question?: string }
  | { type: "decide"; id: string; approve: boolean }
  | { type: "answer"; id: string; text: string }
  | { type: "doctor" }
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

  // Answers to an agent's question: "/answer ab12cd use the blue logo"
  const answer = /^\/?answer\s+#?([0-9a-f]{6})\s+([\s\S]+)$/i.exec(text);
  if (answer) return { type: "answer", id: answer[1].toLowerCase(), text: answer[2].trim() };

  // Approval answers: "/approve ab12cd", "yes ab12cd", "deny ab12cd", "no ab12cd".
  const decision = /^\/?(approve|approved|yes|ok|allow|deny|denied|no|reject)\s+#?([0-9a-f]{6})$/i.exec(text);
  if (decision) {
    return { type: "decide", id: decision[2].toLowerCase(), approve: /^(approve|approved|yes|ok|allow)$/i.test(decision[1]) };
  }

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
      case "approvals":
      case "pending":
        return { type: "approvals" };
      case "inbox":
      case "email":
      case "mail":
        return parseInbox(args);
      case "doctor":
      case "health":
      case "check":
        return { type: "doctor" };
      case "answer":
        return { type: "error", message: "Usage: /answer <id> <your answer>" };
      case "approve":
      case "deny":
        return { type: "error", message: `Usage: /${cmd} <id>. Send /approvals to see what's waiting.` };
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

  // "summarize my inbox", "anything urgent in my email?", "check my mail"
  if (MAIL_ASK.test(text)) {
    const plain = /^(please\s+)?(summari[sz]e|check|review|go through)\s+(my\s+)?(inbox|e-?mails?|mail)\s*[.!?]*$/i.test(text);
    return { type: "inbox", mode: "summary", hours: 24, unreadOnly: false, question: plain ? undefined : text };
  }

  return { type: "auto", text };
}

const MAIL_ASK =
  /\b(summari[sz]e|check|review|go through|what'?s|whats|anything|any|did i get|do i have)\b[^.?!]*\b(my\s+)?(inbox|e-?mails?|my mail)\b/i;

/** /inbox [unread] [48h|3d] · /inbox search <words> · /inbox summary [48h] [question] */
export function parseInbox(args: string[]): Command {
  let mode: "list" | "summary" = "list";
  let unreadOnly = false;
  let hours = 24;
  let text: string | undefined;
  const rest: string[] = [];
  const words = [...args];
  if (/^(summary|summarize|summarise|digest)$/i.test(words[0] ?? "")) {
    mode = "summary";
    words.shift();
  } else if (/^(search|find)$/i.test(words[0] ?? "")) {
    words.shift();
    text = words.join(" ").trim();
    if (!text) return { type: "error", message: "Usage: /inbox search <words>" };
    return { type: "inbox", mode: "list", hours: 24 * 7, unreadOnly: false, text };
  }
  for (const w of words) {
    const h = /^(\d{1,3})(h|d)?$/i.exec(w);
    if (h && rest.length === 0) hours = Number(h[1]) * (h[2]?.toLowerCase() === "d" ? 24 : 1);
    else if (/^unread$/i.test(w) && rest.length === 0) unreadOnly = true;
    else rest.push(w);
  }
  hours = Math.min(Math.max(hours, 1), 24 * 14);
  const question = rest.join(" ").trim() || undefined;
  if (mode === "list" && question) return { type: "error", message: "Usage: /inbox [unread] [48h] · /inbox search <words> · /inbox summary [question]" };
  return { type: "inbox", mode, hours, unreadOnly, question };
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
  "/inbox            recent email (read-only)",
  "/inbox summary    what needs your attention",
  "/approvals        what's waiting for your OK",
  "/approve <id>     allow it   ·   /deny <id>  block it",
  "/answer <id> …    answer an agent's question (or just reply to its message)",
  "/doctor           check that everything is connected",
].join("\n");
