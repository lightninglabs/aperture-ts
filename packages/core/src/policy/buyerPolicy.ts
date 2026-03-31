/**
 * Buyer-side policy implementations per design doc section 16.2.
 */

import type { BuyerPolicy } from "../types.js";

type PolicyInput = Parameters<BuyerPolicy["assertAllowed"]>[0];

/** Rejects payments above a per-request cap. */
export class BudgetCapPolicy implements BuyerPolicy {
  constructor(private readonly maxPerRequestSat: number) {}

  async assertAllowed(input: PolicyInput): Promise<void> {
    if (input.amountSat > this.maxPerRequestSat) {
      throw new Error(
        `Payment of ${input.amountSat} sat exceeds per-request budget cap of ${this.maxPerRequestSat} sat`,
      );
    }
  }
}

/** Tracks spending within a time window and rejects if exceeded. */
export class WindowBudgetPolicy implements BuyerPolicy {
  private spent = 0;
  private windowStart = Date.now();

  constructor(
    private readonly maxPerWindowSat: number,
    private readonly windowMs: number,
  ) {}

  async assertAllowed(input: PolicyInput): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      // Reset window.
      this.spent = 0;
      this.windowStart = now;
    }

    if (this.spent + input.amountSat > this.maxPerWindowSat) {
      throw new Error(
        `Payment of ${input.amountSat} sat would exceed window budget of ${this.maxPerWindowSat} sat ` +
          `(${this.spent} sat already spent in current window)`,
      );
    }

    this.spent += input.amountSat;
  }
}

/** Only allows payments to whitelisted hosts. */
export class HostAllowlistPolicy implements BuyerPolicy {
  private readonly allowed: Set<string>;

  constructor(hosts: string[]) {
    this.allowed = new Set(hosts);
  }

  async assertAllowed(input: PolicyInput): Promise<void> {
    if (!this.allowed.has(input.host)) {
      throw new Error(
        `Host ${input.host} is not in the allowlist`,
      );
    }
  }
}

/** Only allows payments for whitelisted route IDs. */
export class RouteAllowlistPolicy implements BuyerPolicy {
  private readonly allowed: Set<string>;

  constructor(routeIds: string[]) {
    this.allowed = new Set(routeIds);
  }

  async assertAllowed(input: PolicyInput): Promise<void> {
    if (input.routeId && !this.allowed.has(input.routeId)) {
      throw new Error(
        `Route ${input.routeId} is not in the allowlist`,
      );
    }
  }
}

/** Composes multiple buyer policies; all must pass. */
export class CompositeBuyerPolicy implements BuyerPolicy {
  constructor(private readonly policies: BuyerPolicy[]) {}

  async assertAllowed(input: PolicyInput): Promise<void> {
    for (const policy of this.policies) {
      await policy.assertAllowed(input);
    }
  }
}
