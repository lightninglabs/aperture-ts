/**
 * SellerStateDO: Durable Object for per-seller state coordination.
 *
 * Responsibilities (design doc section 10):
 * - Challenge state storage and reuse by requestFingerprint.
 * - Receipt summary writes.
 * - Optional usage counters for maxUses.
 * - Token revocation state.
 */

import type { ChallengeState, ReceiptSummary } from "@lightninglabs/aperture-core";

export class SellerStateDO implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/challenge/get":
        return this.handleGetChallenge(request);
      case "/challenge/persist":
        return this.handlePersistChallenge(request);
      case "/receipt/write":
        return this.handleWriteReceipt(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private async handleGetChallenge(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      requestFingerprint: string;
      idempotencyKey?: string;
    };

    // Look up by request fingerprint.
    const key = `challenge:${body.requestFingerprint}`;
    const existing = await this.state.storage.get<ChallengeState>(key);

    if (existing && existing.status === "issued") {
      // Check if not expired.
      const expiresAt = new Date(existing.expiresAt).getTime();
      if (Date.now() < expiresAt) {
        return Response.json(existing);
      }
      // Expired — remove and return null.
      await this.state.storage.delete(key);
    }

    return Response.json(null);
  }

  private async handlePersistChallenge(request: Request): Promise<Response> {
    const challenge = (await request.json()) as ChallengeState;
    const key = `challenge:${challenge.requestFingerprint}`;

    await this.state.storage.put(key, challenge);

    return Response.json({ ok: true });
  }

  private async handleWriteReceipt(request: Request): Promise<Response> {
    const receipt = (await request.json()) as ReceiptSummary;
    const key = `receipt:${receipt.receiptId}`;

    await this.state.storage.put(key, receipt);

    return Response.json({ ok: true });
  }
}
