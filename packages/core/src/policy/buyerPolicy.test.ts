import { describe, it, expect } from "vitest";
import {
  BudgetCapPolicy,
  WindowBudgetPolicy,
  HostAllowlistPolicy,
  CompositeBuyerPolicy,
} from "./buyerPolicy.js";

const input = (amountSat: number, host = "api.example.com") => ({
  url: `https://${host}/v1/search`,
  host,
  amountSat,
});

describe("BudgetCapPolicy", () => {
  it("allows payments under cap", async () => {
    const policy = new BudgetCapPolicy(100);
    await expect(policy.assertAllowed(input(50))).resolves.toBeUndefined();
  });

  it("rejects payments over cap", async () => {
    const policy = new BudgetCapPolicy(100);
    await expect(policy.assertAllowed(input(150))).rejects.toThrow("budget cap");
  });
});

describe("WindowBudgetPolicy", () => {
  it("allows spending within window", async () => {
    const policy = new WindowBudgetPolicy(100, 60_000);
    await expect(policy.assertAllowed(input(40))).resolves.toBeUndefined();
    await expect(policy.assertAllowed(input(40))).resolves.toBeUndefined();
  });

  it("rejects when window budget exhausted", async () => {
    const policy = new WindowBudgetPolicy(100, 60_000);
    await policy.assertAllowed(input(60));
    await policy.assertAllowed(input(30));
    await expect(policy.assertAllowed(input(20))).rejects.toThrow("window budget");
  });
});

describe("HostAllowlistPolicy", () => {
  it("allows whitelisted hosts", async () => {
    const policy = new HostAllowlistPolicy(["api.example.com"]);
    await expect(policy.assertAllowed(input(10))).resolves.toBeUndefined();
  });

  it("rejects non-whitelisted hosts", async () => {
    const policy = new HostAllowlistPolicy(["api.example.com"]);
    await expect(
      policy.assertAllowed(input(10, "evil.com")),
    ).rejects.toThrow("not in the allowlist");
  });
});

describe("CompositeBuyerPolicy", () => {
  it("all must pass", async () => {
    const composite = new CompositeBuyerPolicy([
      new BudgetCapPolicy(100),
      new HostAllowlistPolicy(["api.example.com"]),
    ]);
    await expect(composite.assertAllowed(input(50))).resolves.toBeUndefined();
  });

  it("fails if any policy rejects", async () => {
    const composite = new CompositeBuyerPolicy([
      new BudgetCapPolicy(100),
      new HostAllowlistPolicy(["other.com"]),
    ]);
    await expect(composite.assertAllowed(input(50))).rejects.toThrow();
  });
});
