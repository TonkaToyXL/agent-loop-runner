#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import {
  checksSummary,
  isMergeReady,
  listChecks,
  unresolvedReviewThreads,
  viewPr,
  waitForChecks,
} from "./gh.js";

const MAX_ITERATIONS = 5;
const LOG_ROOT = join(homedir(), ".local/share/agent-relay/pr-babysit");

type Args = {
  repo: string;
  prNumber: number;
  cwd: string;
};

function parseArgs(argv: string[]): Args {
  let repo = "";
  let prNumber = 0;
  let cwd = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      repo = argv[++i] ?? "";
    } else if (arg === "--pr-number" || arg === "--pr") {
      prNumber = Number(argv[++i]);
    } else if (arg === "--cwd") {
      cwd = resolve(argv[++i] ?? cwd);
    }
  }

  if (!repo || !Number.isFinite(prNumber) || prNumber <= 0) {
    console.error("Usage: babysit-pr --repo owner/repo --pr-number <n> [--cwd /path/to/repo]");
    process.exit(1);
  }
  return { repo, prNumber, cwd };
}

async function logIteration(repo: string, prNumber: number, payload: Record<string, unknown>) {
  const dir = join(LOG_ROOT, repo.replace("/", "__"));
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload });
  await appendFile(join(dir, `pr-${prNumber}.jsonl`), `${line}\n`, "utf8");
}

function buildPrompt(repo: string, prNumber: number, iteration: number): string {
  const pr = viewPr(repo, prNumber);
  const checks = listChecks(repo, prNumber);
  const summary = checksSummary(checks);
  const threads = unresolvedReviewThreads(repo, prNumber);

  return [
    `Babysit PR #${prNumber} in ${repo} (iteration ${iteration}/${MAX_ITERATIONS}).`,
    `Goal: make the PR merge-ready.`,
    "",
    `PR: ${pr.title}`,
    `URL: ${pr.url}`,
    `State: ${pr.state}, mergeable=${pr.mergeable}, draft=${pr.isDraft}`,
    `Branches: ${pr.headRefName} -> ${pr.baseRefName}`,
    `Unresolved top-level review comments: ${threads}`,
    `CI failing checks: ${summary.failing.join(", ") || "none"}`,
    "",
    "Rules:",
    "- Fix only issues in this PR's scope.",
    "- Resolve valid review comments and Bugbot findings; skip invalid ones with a short note.",
    "- If merge conflicts need human judgment, stop and report instead of guessing.",
    "- Never modify CI workflows/checks just to make failures pass.",
    "- Push scoped fixes, then stop.",
    "",
    "Return a short verdict first, then what you changed.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("CURSOR_API_KEY is required");
    process.exit(1);
  }

  await logIteration(args.repo, args.prNumber, { event: "start", cwd: args.cwd });

  await using agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: args.cwd },
  });

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const pr = viewPr(args.repo, args.prNumber);
    const checks = listChecks(args.repo, args.prNumber);

    if (isMergeReady(pr, checks)) {
      await logIteration(args.repo, args.prNumber, {
        event: "done",
        iteration,
        status: "merge_ready",
      });
      console.log(`PR #${args.prNumber} is merge-ready.`);
      return;
    }

    if (pr.mergeable === "CONFLICTING") {
      await logIteration(args.repo, args.prNumber, {
        event: "blocked",
        iteration,
        reason: "merge_conflicts",
      });
      console.error("PR has merge conflicts that need human resolution.");
      process.exit(2);
    }

    const prompt = buildPrompt(args.repo, args.prNumber, iteration);
    await logIteration(args.repo, args.prNumber, { event: "prompt", iteration, prompt });

    try {
      const run = await agent.send(prompt);
      for await (const event of run.stream()) {
        if (event.type === "status") {
          console.log(`[babysit] ${event.status}`);
        }
      }
      const result = await run.wait();
      await logIteration(args.repo, args.prNumber, {
        event: "agent_result",
        iteration,
        status: result.status,
        durationMs: result.durationMs,
      });
      if (result.status !== "finished") {
        console.error(`Agent run ended with status: ${result.status}`);
        process.exit(3);
      }
    } catch (err) {
      const message = err instanceof CursorAgentError ? err.message : String(err);
      await logIteration(args.repo, args.prNumber, { event: "agent_error", iteration, message });
      console.error(message);
      process.exit(err instanceof CursorAgentError && err.isRetryable ? 75 : 1);
    }

    const afterChecks = await waitForChecks(args.repo, args.prNumber);
    const summary = checksSummary(afterChecks);
    await logIteration(args.repo, args.prNumber, {
      event: "checks",
      iteration,
      green: summary.green,
      failing: summary.failing,
    });

    if (isMergeReady(viewPr(args.repo, args.prNumber), afterChecks)) {
      console.log(`PR #${args.prNumber} is merge-ready after iteration ${iteration}.`);
      return;
    }
  }

  await logIteration(args.repo, args.prNumber, { event: "max_iterations", iterations: MAX_ITERATIONS });
  console.error(`Stopped after ${MAX_ITERATIONS} iterations; PR is not merge-ready yet.`);
  process.exit(4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
