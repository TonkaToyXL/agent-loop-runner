import { describe, it, expect } from "vitest";
import { checksSummary, isMergeReady, CheckRun, PrView } from "./gh.js"; // Or just './gh' since it's vitest/ts

describe("checksSummary", () => {
  it("all checks pass means green=true and failing empty", () => {
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
      { name: "test2", state: "SUCCESS", bucket: "pass" },
    ];
    expect(checksSummary(checks)).toEqual({ green: true, failing: [] });
  });

  it("one FAILURE means green=false and failing contains that name", () => {
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
      { name: "test2", state: "FAILURE", bucket: "fail" },
    ];
    expect(checksSummary(checks)).toEqual({ green: false, failing: ["test2"] });
  });

  it("one ERROR means green=false and failing contains that name", () => {
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
      { name: "test2", state: "ERROR", bucket: "fail" },
    ];
    expect(checksSummary(checks)).toEqual({ green: false, failing: ["test2"] });
  });

  it("one PENDING with rest passing means green=false and failing empty", () => {
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
      { name: "test2", state: "PENDING", bucket: "pending" },
    ];
    expect(checksSummary(checks)).toEqual({ green: false, failing: [] });
  });

  it("one IN_PROGRESS with rest passing means green=false and failing empty", () => {
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
      { name: "test2", state: "IN_PROGRESS", bucket: "pending" },
    ];
    expect(checksSummary(checks)).toEqual({ green: false, failing: [] });
  });

  it("empty checks array means green=false and failing empty", () => {
    const checks: CheckRun[] = [];
    expect(checksSummary(checks)).toEqual({ green: false, failing: [] });
  });
});

describe("isMergeReady", () => {
  const basePr: PrView = {
    number: 1,
    title: "Test PR",
    url: "https://github.com/test/repo/pull/1",
    mergeable: "MERGEABLE",
    state: "OPEN",
    headRefName: "feature",
    baseRefName: "main",
    isDraft: false,
  };

  it("OPEN and MERGEABLE and all green means true", () => {
    const pr: PrView = { ...basePr };
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
    ];
    expect(isMergeReady(pr, checks)).toBe(true);
  });

  it("draft PR means false", () => {
    const pr: PrView = { ...basePr, isDraft: true };
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
    ];
    expect(isMergeReady(pr, checks)).toBe(false);
  });

  it("CLOSED PR means false", () => {
    const pr: PrView = { ...basePr, state: "CLOSED" };
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
    ];
    expect(isMergeReady(pr, checks)).toBe(false);
  });

  it("CONFLICTING mergeable means false", () => {
    const pr: PrView = { ...basePr, mergeable: "CONFLICTING" };
    const checks: CheckRun[] = [
      { name: "test1", state: "SUCCESS", bucket: "pass" },
    ];
    expect(isMergeReady(pr, checks)).toBe(false);
  });

  it("MERGEABLE but checks failing means false", () => {
    const pr: PrView = { ...basePr };
    const checks: CheckRun[] = [
      { name: "test1", state: "FAILURE", bucket: "fail" },
    ];
    expect(isMergeReady(pr, checks)).toBe(false);
  });

  it("MERGEABLE but checks pending means false", () => {
    const pr: PrView = { ...basePr };
    const checks: CheckRun[] = [
      { name: "test1", state: "PENDING", bucket: "pending" },
    ];
    expect(isMergeReady(pr, checks)).toBe(false);
  });
});
