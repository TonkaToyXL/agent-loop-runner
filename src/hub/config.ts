import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REASONING_LEVELS, type AgentConfig, type HubConfig, type Reasoning } from "./types.js";

export function isReasoning(value: unknown): value is Reasoning {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Validate one agent entry and fill safe defaults. Throws with a readable message. */
export function normalizeAgent(raw: Partial<AgentConfig>, index: number): AgentConfig {
  const where = `agents[${index}]`;
  if (!raw.id || !/^[a-z0-9][a-z0-9_-]*$/.test(raw.id)) {
    throw new Error(`${where}.id must be lowercase letters, digits, - or _`);
  }
  if (!raw.model) throw new Error(`${where}.model is required`);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    color: raw.color ?? "#c6f432",
    tagline: raw.tagline ?? "",
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.personality ? { personality: raw.personality } : {}),
    ...(Array.isArray(raw.traits) && raw.traits.length ? { traits: raw.traits.map((t) => String(t).trim()).filter(Boolean).slice(0, 4) } : {}),
    ...(raw.motto ? { motto: raw.motto } : {}),
    ...(raw.thinkingLabel ? { thinkingLabel: raw.thinkingLabel } : {}),
    ...(raw.quickAction?.label && raw.quickAction?.prompt
      ? { quickAction: { label: raw.quickAction.label, prompt: raw.quickAction.prompt } }
      : {}),
    model: raw.model,
    provider: raw.provider ?? "",
    modelOptions: Array.from(new Set([raw.model, ...(raw.modelOptions ?? [])])),
    reasoning: isReasoning(raw.reasoning) ? raw.reasoning : "medium",
    skills: (raw.skills ?? []).map((s) => s.toLowerCase()),
    system: raw.system ?? `You are ${raw.name ?? raw.id}.`,
    connectors: raw.connectors ?? [],
    limits: {
      dailyRequests: num(raw.limits?.dailyRequests, 0),
      dailyTokens: num(raw.limits?.dailyTokens, 0),
      monthlyBudgetUsd: num(raw.limits?.monthlyBudgetUsd, 0),
    },
    pricing: {
      inputPerMTok: num(raw.pricing?.inputPerMTok, 0),
      outputPerMTok: num(raw.pricing?.outputPerMTok, 0),
    },
    enabled: raw.enabled ?? true,
    optional: raw.optional ?? false,
    actsInWorld: raw.actsInWorld ?? false,
    maxConcurrent: Math.max(1, Math.floor(num(raw.maxConcurrent, 2))),
  };
}

export function loadConfig(path = process.env.RELAY_CONFIG?.trim() || "relay.config.json"): HubConfig {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`Config not found: ${full}`);
  const raw = JSON.parse(readFileSync(full, "utf8")) as Partial<HubConfig>;
  const agents = (raw.agents ?? []).map((a, i) => normalizeAgent(a, i));
  if (agents.length === 0) throw new Error("Config needs at least one agent");
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }
  const lead = raw.lead && ids.has(raw.lead) ? raw.lead : agents[0].id;
  return { lead, agents };
}
