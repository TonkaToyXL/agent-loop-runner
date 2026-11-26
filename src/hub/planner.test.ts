import { describe, expect, it } from "vitest";
import { fallbackPlan, parsePlan, planPrompt, readySteps, stepPrompt, synthesisPrompt, type PlannerAgent } from "./planner.js";

const team: PlannerAgent[] = [
  { id: "grok", name: "Grok", skills: ["x", "news", "research"], tagline: "Live scout", enabled: true },
  { id: "muse", name: "Muse", skills: ["write", "copy", "hooks"], tagline: "Creative lead", enabled: true },
  { id: "hermes", name: "Hermes", skills: ["code", "plan", "automate"], tagline: "Operator", enabled: true },
];
const ids = team.map((a) => a.id);

describe("parsePlan", () => {
  it("reads a plain JSON array; steps without 'after' start right away", () => {
    expect(parsePlan('[{"agent":"grok","task":"scan X"}]', ids)).toEqual([{ agentId: "grok", task: "scan X", after: [] }]);
  });

  it("tolerates code fences, prose, @ prefixes and alternate keys", () => {
    const reply = 'Here you go:\n```json\n[{"agent":"@Muse","task":"write hooks"},{"agentId":"hermes","prompt":"make a checklist"}]\n```';
    expect(parsePlan(reply, ids)).toEqual([
      { agentId: "muse", task: "write hooks", after: [] },
      { agentId: "hermes", task: "make a checklist", after: [] },
    ]);
  });

  it("maps step numbers in 'after' to earlier steps", () => {
    const plan = parsePlan(
      JSON.stringify([
        { step: 1, agent: "grok", task: "research" },
        { step: 2, agent: "muse", task: "write from research", after: [1] },
        { step: 3, agent: "hermes", task: "review draft", after: [2, 1] },
      ]),
      ids,
    );
    expect(plan?.map((s) => s.after)).toEqual([[], [0], [0, 1]]);
  });

  it("ignores self, forward, and unknown references, so plans can't deadlock", () => {
    const plan = parsePlan(
      JSON.stringify([
        { step: 1, agent: "grok", task: "a", after: [1, 2] },
        { step: 2, agent: "muse", task: "b", after: 9 },
        { step: 3, agent: "hermes", task: "c", depends_on: "2" },
      ]),
      ids,
    );
    expect(plan?.map((s) => s.after)).toEqual([[], [], [1]]);
  });

  it("keeps numbering right when invalid steps are dropped", () => {
    const plan = parsePlan(
      JSON.stringify([
        { step: 1, agent: "zeus", task: "dropped" },
        { step: 2, agent: "grok", task: "research" },
        { step: 3, agent: "muse", task: "write", after: [2] },
      ]),
      ids,
    );
    expect(plan).toEqual([
      { agentId: "grok", task: "research", after: [] },
      { agentId: "muse", task: "write", after: [0] },
    ]);
  });

  it("drops unknown agents and empty tasks, and caps at 6 steps", () => {
    const many = JSON.stringify(Array.from({ length: 9 }, () => ({ agent: "grok", task: "x" })));
    expect(parsePlan(many, ids)).toHaveLength(6);
    expect(parsePlan('[{"agent":"zeus","task":"x"},{"agent":"grok","task":""}]', ids)).toBeNull();
  });

  it("returns null for non-JSON replies", () => {
    expect(parsePlan("I think Grok should do it.", ids)).toBeNull();
    expect(parsePlan("[not json]", ids)).toBeNull();
  });

  it("extracts JSON arrays even when surrounding prose contains square brackets", () => {
    const reply =
      'Plan [2 steps]:\n```json\n[{"step":1,"agent":"grok","task":"scan X [today]"},{"step":2,"agent":"muse","task":"write copy","after":[1]}]\n```\n[ready]';
    expect(parsePlan(reply, ids)).toEqual([
      { agentId: "grok", task: "scan X [today]", after: [] },
      { agentId: "muse", task: "write copy", after: [0] },
    ]);
  });
});

describe("readySteps", () => {
  const steps = [
    { agentId: "grok", task: "a", after: [] },
    { agentId: "muse", task: "b", after: [0] },
    { agentId: "hermes", task: "c", after: [] },
    { agentId: "grok", task: "d", after: [1, 2] },
  ];
  it("starts independent steps first, then each step once its inputs finish", () => {
    expect(readySteps(steps, new Set(), new Set())).toEqual([0, 2]);
    expect(readySteps(steps, new Set([0]), new Set([0, 2]))).toEqual([1]);
    expect(readySteps(steps, new Set([0, 1]), new Set([0, 1, 2]))).toEqual([]);
    expect(readySteps(steps, new Set([0, 1, 2]), new Set([0, 1, 2]))).toEqual([3]);
  });
});

describe("stepPrompt", () => {
  it("passes earlier results forward fenced as untrusted data, marked by step and agent", () => {
    const p = stepPrompt("Write the post", [{ step: 1, agentName: "Grok", ok: true, text: "people love it" }]);
    expect(p).toContain("Write the post");
    expect(p).toContain("### Step 1 · Grok");
    expect(p).toContain('<teammate_output step="1" agent="Grok">\npeople love it\n</teammate_output>');
    expect(p).toMatch(/untrusted data/i);
  });

  it("leaves independent steps untouched and trims very long inputs", () => {
    expect(stepPrompt("solo", [])).toBe("solo");
    const long = stepPrompt("t", [{ step: 1, agentName: "Grok", ok: false, text: "x".repeat(9000) }]);
    expect(long).toContain("(failed)");
    expect(long).toContain("[…cut for length]");
    expect(long.length).toBeLessThan(7000);
  });
});

describe("fallbackPlan", () => {
  it("uses agents whose skills match the goal, in parallel", () => {
    const plan = fallbackPlan("research news on X and write hooks", team);
    expect(plan.map((s) => s.agentId).sort()).toEqual(["grok", "muse"]);
    expect(plan.every((s) => s.after.length === 0)).toBe(true);
  });

  it("uses the whole enabled crew when fewer than two match", () => {
    const plan = fallbackPlan("make it great", [...team.slice(0, 2), { ...team[2], enabled: false }]);
    expect(plan.map((s) => s.agentId)).toEqual(["grok", "muse"]);
  });
});

describe("prompts", () => {
  it("lists only enabled agents and explains 'after'", () => {
    const prompt = planPrompt("ship it", [...team.slice(0, 2), { ...team[2], enabled: false }]);
    expect(prompt).toContain("grok (Grok)");
    expect(prompt).not.toContain("hermes (Hermes)");
    expect(prompt).toContain('"after"');
    expect(prompt).toContain("Goal: ship it");
  });

  it("labels steps and marks failed ones in the wrap-up prompt", () => {
    const prompt = synthesisPrompt("ship it", [
      { agentName: "Grok", ok: true, text: "done" },
      { agentName: "Muse", ok: false, text: "timeout" },
    ]);
    expect(prompt).toContain("### Step 1 · Grok");
    expect(prompt).toContain('<teammate_output step="1" agent="Grok">\ndone\n</teammate_output>');
    expect(prompt).toContain("### Step 2 · Muse (failed)");
    expect(prompt).toContain("do not run tools");
  });
});
