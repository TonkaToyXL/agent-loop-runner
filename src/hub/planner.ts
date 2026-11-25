export interface PlanStep {
  agentId: string;
  task: string;
  /** 0-based indexes of earlier steps this one builds on. Empty = can start right away. */
  after: number[];
}

export interface PlannerAgent {
  id: string;
  name: string;
  skills: string[];
  tagline: string;
  enabled: boolean;
}

const MAX_STEPS = 6;
/** How much of an earlier step's answer to pass forward. */
const MAX_HANDOFF_CHARS = 6000;

export function planPrompt(goal: string, agents: PlannerAgent[]): string {
  const roster = agents
    .filter((a) => a.enabled)
    .map((a) => `- ${a.id} (${a.name}): ${a.tagline}. Strengths: ${a.skills.slice(0, 10).join(", ")}`)
    .join("\n");
  return [
    "You lead a team of AI agents. Break the goal into 1 to 6 steps and give each step to the",
    "agent best suited for it.",
    "",
    "Steps run in parallel unless one needs another's result. When a step needs earlier work",
    '(for example, write copy from research, or review a draft), list those step numbers in "after".',
    "A step only sees the results of the steps it lists. Only point back to earlier steps.",
    "",
    "Team:",
    roster,
    "",
    `Goal: ${goal}`,
    "",
    "Reply with only a JSON array, no prose. Example:",
    '[{"step":1,"agent":"grok","task":"Find ..."},{"step":2,"agent":"muse","task":"Write ... using the findings","after":[1]}]',
    "Each task must say exactly what to produce and in what format.",
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

  // First pass: keep valid steps and remember how the model numbered them.
  const kept: { agentId: string; task: string; label: number; afterRaw: unknown }[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const rec = item as Record<string, unknown>;
    const agentId = String(rec.agent ?? rec.agentId ?? "").toLowerCase().replace(/^@/, "");
    const task = String(rec.task ?? rec.prompt ?? "").trim();
    if (!ids.has(agentId) || !task) return;
    const label = Number(rec.step ?? rec.id ?? i + 1);
    kept.push({ agentId, task, label: Number.isFinite(label) ? label : i + 1, afterRaw: rec.after ?? rec.depends_on ?? rec.dependsOn });
  });
  if (!kept.length) return null;
  const steps = kept.slice(0, MAX_STEPS);

  // Second pass: map dependency labels to indexes, keeping only earlier steps (no cycles possible).
  return steps.map((s, i) => {
    const refs = Array.isArray(s.afterRaw) ? s.afterRaw : s.afterRaw === undefined || s.afterRaw === null ? [] : [s.afterRaw];
    const after = new Set<number>();
    for (const ref of refs) {
      const n = Number(ref);
      const idx = steps.findIndex((o) => o.label === n);
      if (idx >= 0 && idx < i) after.add(idx);
    }
    return { agentId: s.agentId, task: s.task, after: [...after].sort((a, b) => a - b) };
  });
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
    after: [],
  }));
}

export interface StepResult {
  step: number;
  agentName: string;
  ok: boolean;
  text: string;
}

/** The prompt a step actually receives: its task plus the results it builds on. */
export function stepPrompt(task: string, inputs: StepResult[]): string {
  if (!inputs.length) return task;
  const body = inputs
    .map((r) => {
      const text = r.text.length > MAX_HANDOFF_CHARS ? `${r.text.slice(0, MAX_HANDOFF_CHARS)}\n[…cut for length]` : r.text;
      return `### Step ${r.step} · ${r.agentName}${r.ok ? "" : " (failed)"}\n${text}`;
    })
    .join("\n\n");
  return `${task}\n\nResults from earlier steps that you build on:\n\n${body}`;
}

/** Steps whose dependencies are all finished and that haven't started yet. */
export function readySteps(steps: PlanStep[], finished: Set<number>, started: Set<number>): number[] {
  return steps.map((s, i) => i).filter((i) => !started.has(i) && steps[i].after.every((d) => finished.has(d)));
}

export function synthesisPrompt(goal: string, parts: { agentName: string; ok: boolean; text: string }[]): string {
  const body = parts.map((p, i) => `### Step ${i + 1} · ${p.agentName}${p.ok ? "" : " (failed)"}\n${p.text}`).join("\n\n");
  return [
    `Goal: ${goal}`,
    "",
    "Your teammates worked through the steps of this goal. Combine their work into one finished answer.",
    "Lead with the result. Later steps usually build on earlier ones, so prefer the most refined version.",
    "Drop repetition, and say plainly if any step failed.",
    "",
    body,
  ].join("\n");
}
