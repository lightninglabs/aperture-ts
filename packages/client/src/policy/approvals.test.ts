import { describe, it, expect } from "vitest";
import { ManualApprovalPolicy } from "./approvals.js";

describe("ManualApprovalPolicy", () => {
  it("allows when approval function returns true", async () => {
    const policy = new ManualApprovalPolicy(async () => true);
    await expect(
      policy.assertAllowed({
        url: "https://api.example.com/v1",
        host: "api.example.com",
        amountSat: 10,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when approval function returns false", async () => {
    const policy = new ManualApprovalPolicy(async () => false);
    await expect(
      policy.assertAllowed({
        url: "https://api.example.com/v1",
        host: "api.example.com",
        amountSat: 10,
      }),
    ).rejects.toThrow("manually rejected");
  });
});
