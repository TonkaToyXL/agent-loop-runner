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

const AGENT_ALIASES: Record<string, string> = {
  gpt: "chatgpt",
  codex: "chatgpt",
  opencode: "zen",
};

export function resolveAgent(token: string, agents: AgentRef[]): string | null {
  const t = token.toLowerCase().replace(/^@/, "");
  const hit = agents.find((a) => a.id === t || a.name.toLowerCase() === t);
  if (hit) return hit.id;
  const alias = AGENT_ALIASES[t];
  return alias && agents.some((a) => a.id === alias) ? alias : null;
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
          return { type: "error", message: "Usage: /reasoning <agent> auto|off|low|medium|high|max" };
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
        if (agentId) {
          return body ? { type: "ask", agentId, text: body } : { type: "error", message: `Usage: /${agentId} <your ask> (or @${agentId} <your ask>)` };
        }
        if (TEAM_WORDS.has(cmd)) {
          return body ? { type: "team", text: body } : { type: "error", message: `Usage: /${cmd} <goal>` };
        }
        return { type: "error", message: `Unknown command /${cmd}. Try /help.` };
      }
    }
  }

  const bareMention = /^@([\w-]+)$/.exec(text);
  if (bareMention) {
    const who = bareMention[1];
    if (TEAM_WORDS.has(who.toLowerCase())) return { type: "error", message: `Usage: @${who} <goal>` };
    const agentId = resolveAgent(who, agents);
    return agentId
      ? { type: "error", message: `Usage: @${agentId} <your ask>` }
      : { type: "error", message: `No agent called @${who}. Try /agents.` };
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

/**
 * "Are all the bots up? say hello" / "everyone check in" / "roll call": a request for every
 * assistant to answer, not a goal to plan. Assistants can't contact each other, so Relay asks
 * each one directly. Kept short and greeting-shaped so real team goals never match.
 */
export function isRollCall(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 140) return false;
  if (/\broll[- ]?call\b|\bsound off\b/.test(t)) return true;
  const everyone = /\b(?:all|every|each)(?:\s+(?:of\s+)?(?:the|my|our|your))?\s+(?:bots?|agents?|assistants?|ais?|crew|team(?:mates)?|one)\b|\beveryone\b|\beverybody\b/.test(t);
  const greet = /\b(?:respon(?:sive|ding)|alive|online|awake|say\s+(?:hi|hello|hey)|hello|hi|hey|ping|check(?:ing)?[- ]?in)\b/.test(t);
  return everyone && greet;
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

function matchesSkill(words: string[], skill: string): boolean {
  const s = skill.toLowerCase();
  if (words.includes(s)) return true;
  if (s.length < 4) return false;
  // Simple morphological stem match: "debug" -> "debugging", "write" -> "writing", "analyze" -> "analyzing".
  const stem = s.endsWith("e") && s.length >= 5 ? s.slice(0, -1) : s;
  return words.some((w) => w.startsWith(stem) && w.length <= stem.length + 5);
}

interface IntentRule {
  pattern: RegExp;
  /** Agent IDs or skill markers that strongly own this intent. */
  agentIds: string[];
  requiredSkills: string[];
  weight: number;
}

const INTENT_RULES: IntentRule[] = [
  {
    // Real-time news, X/Twitter, what's new/latest today -> live scout (Grok)
    pattern: /\b(what'?s\s+new|what\s+is\s+new|latest\s+(?:news|updates?|ai|on)|breaking|trending|headlines?|today'?s\s+news|in\s+ai\s+today|on\s+x\b|twitter|tweets?|viral|live\s+pulse)\b/i,
    agentIds: ["grok"],
    requiredSkills: ["x", "news", "trends", "realtime"],
    weight: 4,
  },
  {
    // Local Mac, files, shell, automation, deployment -> operator (Hermes)
    pattern: /\b(my\s+mac|mac\s*mini|macbook|terminal|shell|bash|launchagent|launchd|local\s+files?|folder|directory|restart\s+the|deploy|cron|automate|automation|ssh)\b/i,
    agentIds: ["hermes"],
    requiredSkills: ["terminal", "bash", "automate", "files", "deploy"],
    weight: 4,
  },
  {
    // Creative copy, hooks, video scripts, headlines, naming -> creative lead (Muse)
    pattern: /\b(hook|hooks|caption|captions|tagline|taglines|slogan|(?:video|youtube|podcast|ad|short)\s+script|youtube\s+title|thumbnail\s+text|headline|copywriting|brainstorm|name\s+ideas|pitch\s+\d|write\s+(?:a|an|some|me|\d+)\s+(?:post|caption|hook|tagline|headline|email|story|bio))\b/i,
    agentIds: ["muse"],
    requiredSkills: ["copy", "hooks", "caption", "creative", "write"],
    weight: 4,
  },
  {
    // Code writing, debugging, SQL, regex, refactoring -> coder (Cline)
    pattern: /```|\b(regex|regexp|sql\s+query|typescript|javascript|python|function|refactor|unit\s+test|stack\s*trace|debug(?:ging)?|fix\s+(?:this|the|my)\s+(?:bug|code|error|script)|write\s+(?:a\s+)?(?:script|function|query|regex|code))\b/i,
    agentIds: ["cline"],
    requiredSkills: ["code", "coding", "debug", "refactor", "regex", "sql"],
    weight: 3,
  },
  {
    // Reviews, critiques, audits, comparisons, tradeoffs -> analyst/critic (Zen)
    pattern: /\b(review|critique|audit|pressure[- ]?test|trade[- ]?offs?|pros\s+and\s+cons|compare|benchmark|blind\s+spots?|architecture\s+review|security\s+check|what'?s\s+wrong\s+with)\b/i,
    agentIds: ["zen"],
    requiredSkills: ["review", "critique", "audit", "compare", "analysis"],
    weight: 3,
  },
  {
    // High-stakes second opinion / executive strategy -> advisor (ChatGPT)
    pattern: /\b(second\s+opinion|executive\s+advice|high[- ]?stakes|big\s+picture|strategic\s+decision|sanity\s+check)\b/i,
    agentIds: ["chatgpt"],
    requiredSkills: ["second-opinion", "strategy", "chatgpt"],
    weight: 4,
  },
];

export interface RoutableAgent {
  id: string;
  skills: string[];
  enabled: boolean;
  busy?: number;
  actsInWorld?: boolean;
  conserveQuota?: boolean;
}

/** Pick the agent whose intent + skills best match the text. Ties prefer non-quota-capped, text-only, idle agents, then fallback. */
export function pickAgent(text: string, agents: RoutableAgent[], fallback: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const enabledIds = new Set(agents.filter((a) => a.enabled).map((a) => a.id));
  let best = fallback;
  let bestScore = 0;
  let bestConserve = true;
  let bestActs = true;
  let bestBusy = Number.POSITIVE_INFINITY;

  for (const agent of agents) {
    if (!agent.enabled) continue;
    let score = agent.skills.reduce((n, skill) => n + (matchesSkill(words, skill) ? 1 : 0), 0);
    const skillSet = new Set(agent.skills.map((s) => s.toLowerCase()));
    for (const rule of INTENT_RULES) {
      if (!rule.pattern.test(text)) continue;
      // When a dedicated owner for this intent is enabled, award the intent boost only to its owner(s)
      // so generalists with overlapping skills (e.g. Hermes sharing "code") don't hijack specialist asks.
      const hasDirectOwner = rule.agentIds.some((id) => enabledIds.has(id));
      const matched = hasDirectOwner ? rule.agentIds.includes(agent.id) : rule.requiredSkills.some((s) => skillSet.has(s));
      if (matched) score += rule.weight;
    }
    const busy = agent.busy ?? 0;
    const conserve = Boolean(agent.conserveQuota);
    const acts = Boolean(agent.actsInWorld);
    const better =
      score > bestScore ||
      (score > 0 &&
        score === bestScore &&
        ((!conserve && bestConserve) ||
          (conserve === bestConserve && ((!acts && bestActs) || (acts === bestActs && busy < bestBusy)))));
    if (better) {
      best = agent.id;
      bestScore = score;
      bestConserve = conserve;
      bestActs = acts;
      bestBusy = busy;
    }
  }
  return best;
}

export const HELP_TEXT = [
  "Causeway: one line to your whole crew.",
  "",
  "@grok <ask>       talk to one agent",
  "@team <goal>      lead plans, crew splits the work",
  "roll call         every assistant says hello (\"all bots, say hi\")",
  "<plain text>      auto-picks the best agent",
  "",
  "/agents           models, reasoning, usage",
  "/status           what's running now",
  "/board            who did the most work",
  "/model <agent> <model-id>",
  "/reasoning <agent> auto|off|low|medium|high|max",
  "/lead <agent>     choose who plans team goals",
  "/inbox            recent email (read-only)",
  "/inbox summary    what needs your attention",
  "/approvals        what's waiting for your OK",
  "/approve <id>     allow it   ·   /deny <id>  block it",
  "/answer <id> …    answer an agent's question (or just reply to its message)",
  "/doctor           check that everything is connected",
].join("\n");
