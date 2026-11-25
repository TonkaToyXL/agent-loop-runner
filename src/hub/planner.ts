export interface PlanStep {
  agentId: string;
  task: string;
}

export interface PlannerAgent {
  id: string;
  name: string;
  skills: string[];
  tagline: string;
  enabled: boolean;
}

const MAX_STEPS = 5;

export function planPrompt(goal: string, agents: PlannerAgent[]): string {
  const roster = agents
    .filter((a) => a.enabled)
    .map((a) => `- ${a.id} (${a.name}): ${a.tagline}. Strengths: ${a.skills.slice(0, 10).join(", ")}`)
    .join("\n");
  return [
    "You are the lead of a team of AI agents. Split the goal into 1 to 5 independent subtasks",
    "that can run in parallel, and give each to the agent best suited for it.",
    "",
    "Team:",
    roster,
    "",
    `Goal: ${goal}`,
    "",
    'Reply with only a JSON array, no prose. Example: [{"agent":"grok","task":"..."}]',
    "Each task must stand alone: say exactly what to produce and in what format.",
  ].join("\n");
}

/** Extract a plan from a model reply. Tolerates code fences and prose around the JSON. */
export function parsePlan(text: string, validIds: string[]): PlanStep[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const ids = new Set(validIds);
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const agentId = String(rec.agent ?? rec.agentId ?? "").toLowerCase().replace(/^@/, "");
    const task = String(rec.task ?? rec.prompt ?? "").trim();
    if (ids.has(agentId) && task) steps.push({ agentId, task });
  }
  return steps.length ? steps.slice(0, MAX_STEPS) : null;
}

/** Plan without a model: give the goal to every agent whose skills match, framed by its strengths. */
export function fallbackPlan(goal: string, agents: PlannerAgent[]): PlanStep[] {
  const words = new Set(goal.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const enabled = agents.filter((a) => a.enabled);
  const scored = enabled
    .map((a) => ({ a, score: a.skills.filter((s) => words.has(s)).length }))
    .sort((x, y) => y.score - x.score);
  const matched = scored.filter((s) => s.score > 0).map((s) => s.a);
  const crew = matched.length >= 2 ? matched : scored.slice(0, Math.min(3, scored.length)).map((s) => s.a);
  return crew.slice(0, MAX_STEPS).map((a) => ({
    agentId: a.id,
    task: `${goal}\n\nYour part: cover this from your strengths (${a.tagline.toLowerCase()}). Be concrete and brief.`,
  }));
}

export function synthesisPrompt(goal: string, parts: { agentName: string; ok: boolean; text: string }[]): string {
  const body = parts
    .map((p) => `### ${p.agentName}${p.ok ? "" : " (failed)"}\n${p.text}`)
    .join("\n\n");
  return [
    `Goal: ${goal}`,
    "",
    "Your teammates worked on parts of this goal. Combine their work into one finished answer.",
    "Lead with the result. Keep what is useful, drop repetition, and note any part that failed.",
    "",
    body,
  ].join("\n");
}
