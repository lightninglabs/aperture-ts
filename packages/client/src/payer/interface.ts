/**
 * InvoicePayer interface and mock implementation.
 */

export type { InvoicePayer } from "@aperture/core";

/** Mock payer that returns a known preimage. Used for testing. */
export class MockInvoicePayer {
  private preimages: Map<string, string>;

  constructor(preimages?: Map<string, string>) {
    this.preimages = preimages ?? new Map();
  }

  /** Register a preimage for a payment hash (for mock invoice providers). */
  addPreimage(paymentHash: string, preimageHex: string): void {
    this.preimages.set(paymentHash, preimageHex);
  }

  async payInvoice(input: {
    invoice: string;
    amountSat: number;
    challengeId: string;
  }): Promise<{ preimageHex: string; amountPaidSat: number }> {
    // Extract payment hash from the mock invoice format.
    // Real implementations would decode BOLT11.
    for (const [_hash, preimage] of this.preimages) {
      return { preimageHex: preimage, amountPaidSat: input.amountSat };
    }
    throw new Error("No preimage registered for this invoice");
  }
}
