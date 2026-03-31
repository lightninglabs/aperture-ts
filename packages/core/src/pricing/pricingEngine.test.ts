import { describe, it, expect } from "vitest";
import { resolvePrice } from "./pricingEngine.js";

const req = new Request("https://api.example.com/v1/search", { method: "POST" });

describe("resolvePrice", () => {
  it("fixed pricing returns amount", () => {
    expect(resolvePrice({ kind: "fixed", amountSat: 42 }, { request: req })).toBe(42);
  });

  it("per-request pricing returns amount", () => {
    expect(resolvePrice({ kind: "per-request", amountSat: 5 }, { request: req })).toBe(5);
  });

  it("free-until: free when under quota", () => {
    const policy = { kind: "free-until" as const, quota: 10, thenAmountSat: 50 };
    expect(resolvePrice(policy, { request: req, usageCount: 3 })).toBe(0);
  });

  it("free-until: charges when quota exceeded", () => {
    const policy = { kind: "free-until" as const, quota: 10, thenAmountSat: 50 };
    expect(resolvePrice(policy, { request: req, usageCount: 10 })).toBe(50);
  });

  it("tiered: matches first tier", () => {
    const policy = {
      kind: "tiered" as const,
      tiers: [
        { name: "premium", match: { method: ["POST"] }, amountSat: 20 },
        { name: "default", amountSat: 5 },
      ],
    };
    expect(resolvePrice(policy, { request: req })).toBe(20);
  });

  it("tiered: falls through to default", () => {
    const policy = {
      kind: "tiered" as const,
      tiers: [
        { name: "premium", match: { method: ["DELETE"] }, amountSat: 20 },
        { name: "default", amountSat: 5 },
      ],
    };
    expect(resolvePrice(policy, { request: req })).toBe(5);
  });

  it("dynamic pricing throws (requires async)", () => {
    expect(() =>
      resolvePrice(
        { kind: "dynamic", resolver: { endpoint: "https://pricer.test" } },
        { request: req },
      ),
    ).toThrow("resolveDynamicPrice");
  });
});
