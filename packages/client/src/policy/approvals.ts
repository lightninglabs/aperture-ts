/**
 * Manual approval hook for buyer policy.
 */

import type { BuyerPolicy } from "@lightninglabs/aperture-core";

type PolicyInput = Parameters<BuyerPolicy["assertAllowed"]>[0];

/** Approval function type — returns true to allow, false to reject. */
export type ApprovalFn = (input: PolicyInput) => Promise<boolean>;

/**
 * ManualApprovalPolicy: calls a user-provided approval function before
 * allowing payment. Supports async UI prompts or agent decision hooks.
 */
export class ManualApprovalPolicy implements BuyerPolicy {
  constructor(private readonly approveFn: ApprovalFn) {}

  async assertAllowed(input: PolicyInput): Promise<void> {
    const approved = await this.approveFn(input);
    if (!approved) {
      throw new Error(
        `Payment of ${input.amountSat} sat to ${input.host} was manually rejected`,
      );
    }
  }
}
