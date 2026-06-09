import { execFileSync } from "node:child_process";

export type PrView = {
  number: number;
  title: string;
  url: string;
  mergeable: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
};

export type CheckRun = {
  name: string;
  state: string;
  bucket: string;
  link?: string;
};

function ghJson<T>(args: string[]): T {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out) as T;
}

export function viewPr(repo: string, prNumber: number): PrView {
  return ghJson<PrView>([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "number,title,url,mergeable,state,headRefName,baseRefName,isDraft",
  ]);
}

export function listChecks(repo: string, prNumber: number): CheckRun[] {
  return ghJson<CheckRun[]>([
    "pr",
    "checks",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "name,state,bucket,link",
  ]);
}

export function unresolvedReviewThreads(repo: string, prNumber: number): number {
  try {
    const count = execFileSync(
      "gh",
      [
        "api",
        `repos/${repo}/pulls/${prNumber}/comments`,
        "--paginate",
        "--jq",
        "[.[] | select(.in_reply_to_id == null)] | length",
      ],
      { encoding: "utf8" },
    ).trim();
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

export function checksSummary(checks: CheckRun[]): { green: boolean; failing: string[] } {
  const failing = checks
    .filter((check) => check.bucket === "fail" || check.state === "FAILURE" || check.state === "ERROR")
    .map((check) => check.name);
  const pending = checks.filter(
    (check) => check.bucket === "pending" || check.state === "PENDING" || check.state === "IN_PROGRESS",
  );
  return { green: failing.length === 0 && pending.length === 0 && checks.length > 0, failing };
}

export function isMergeReady(pr: PrView, checks: CheckRun[]): boolean {
  if (pr.isDraft || pr.state !== "OPEN") return false;
  if (pr.mergeable === "CONFLICTING") return false;
  const summary = checksSummary(checks);
  return pr.mergeable === "MERGEABLE" && summary.green;
}

export async function waitForChecks(
  repo: string,
  prNumber: number,
  timeoutMs = 20 * 60 * 1000,
  pollMs = 30_000,
): Promise<CheckRun[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const checks = listChecks(repo, prNumber);
    const summary = checksSummary(checks);
    if (summary.green || summary.failing.length > 0) {
      return checks;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return listChecks(repo, prNumber);
}
