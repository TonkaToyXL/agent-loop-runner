import { describe, expect, it } from "vitest";
import { fallbackPlan, parsePlan, planPrompt, synthesisPrompt, type PlannerAgent } from "./planner.js";

const team: PlannerAgent[] = [
  { id: "grok", name: "Grok", skills: ["x", "news", "research"], tagline: "Live scout", enabled: true },
  { id: "muse", name: "Muse", skills: ["write", "copy", "hooks"], tagline: "Creative lead", enabled: true },
  { id: "hermes", name: "Hermes", skills: ["code", "plan", "automate"], tagline: "Operator", enabled: true },
];
const ids = team.map((a) => a.id);

describe("parsePlan", () => {
  it("reads a plain JSON array", () => {
    expect(parsePlan('[{"agent":"grok","task":"scan X"}]', ids)).toEqual([{ agentId: "grok", task: "scan X" }]);
  });

  it("tolerates code fences, prose, @ prefixes and alternate keys", () => {
    const reply = 'Here you go:\n```json\n[{"agent":"@Muse","task":"write hooks"},{"agentId":"hermes","prompt":"make a checklist"}]\n```';
    expect(parsePlan(reply, ids)).toEqual([
      { agentId: "muse", task: "write hooks" },
      { agentId: "hermes", task: "make a checklist" },
    ]);
  });

  it("drops unknown agents and empty tasks, and caps at 5 steps", () => {
    const many = JSON.stringify(Array.from({ length: 8 }, () => ({ agent: "grok", task: "x" })));
    expect(parsePlan(many, ids)).toHaveLength(5);
    expect(parsePlan('[{"agent":"zeus","task":"x"},{"agent":"grok","task":""}]', ids)).toBeNull();
  });

  it("returns null for non-JSON replies", () => {
    expect(parsePlan("I think Grok should do it.", ids)).toBeNull();
    expect(parsePlan("[not json]", ids)).toBeNull();
  });
});

describe("fallbackPlan", () => {
  it("uses agents whose skills match the goal", () => {
    const plan = fallbackPlan("research news on X and write hooks", team);
    expect(plan.map((s) => s.agentId).sort()).toEqual(["grok", "muse"]);
  });

  it("uses the whole enabled crew when fewer than two match", () => {
    const plan = fallbackPlan("make it great", [...team.slice(0, 2), { ...team[2], enabled: false }]);
    expect(plan.map((s) => s.agentId)).toEqual(["grok", "muse"]);
  });
});

describe("prompts", () => {
  it("lists only enabled agents in the plan prompt", () => {
    const prompt = planPrompt("ship it", [...team.slice(0, 2), { ...team[2], enabled: false }]);
    expect(prompt).toContain("grok (Grok)");
    expect(prompt).not.toContain("hermes (Hermes)");
    expect(prompt).toContain("Goal: ship it");
  });

  it("marks failed parts in the synthesis prompt", () => {
    const prompt = synthesisPrompt("ship it", [
      { agentName: "Grok", ok: true, text: "done" },
      { agentName: "Muse", ok: false, text: "timeout" },
    ]);
    expect(prompt).toContain("### Grok\ndone");
    expect(prompt).toContain("### Muse (failed)\ntimeout");
  });
});
