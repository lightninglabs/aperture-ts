/**
 * Typed client for calling SellerStateDO methods from the Worker.
 */

import type { ChallengeState, ReceiptSummary } from "@aperture/core";

export class SellerStateClient {
  private stub: DurableObjectStub;

  constructor(namespace: DurableObjectNamespace, sellerId: string) {
    const id = namespace.idFromName(`seller:${sellerId}`);
    this.stub = namespace.get(id);
  }

  async getChallenge(
    requestFingerprint: string,
    idempotencyKey?: string,
  ): Promise<ChallengeState | null> {
    const response = await this.stub.fetch(
      "https://do/challenge/get",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestFingerprint, idempotencyKey }),
      },
    );
    return response.json();
  }

  async persistChallenge(challenge: ChallengeState): Promise<void> {
    await this.stub.fetch("https://do/challenge/persist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(challenge),
    });
  }

  async writeReceipt(receipt: ReceiptSummary): Promise<void> {
    await this.stub.fetch("https://do/receipt/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(receipt),
    });
  }
}
