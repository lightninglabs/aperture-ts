/**
 * MockInvoiceProvider: generates fake invoices for testing and local dev.
 */

import type {
  InvoiceProvider,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
} from "@lightninglabs/aperture-core";

export class MockInvoiceProvider implements InvoiceProvider {
  /** Map of paymentHash → preimage for test verification. */
  readonly preimages = new Map<string, string>();

  async createInvoice(
    req: CreateInvoiceRequest,
  ): Promise<CreateInvoiceResponse> {
    // Generate deterministic fake payment hash and preimage.
    const preimageBytes = new Uint8Array(32);
    crypto.getRandomValues(preimageBytes);
    const preimageHex = bytesToHex(preimageBytes);

    const hashBuffer = await crypto.subtle.digest("SHA-256", preimageBytes);
    const paymentHash = bytesToHex(new Uint8Array(hashBuffer));

    this.preimages.set(paymentHash, preimageHex);

    const expiresAt = new Date(
      Date.now() + req.expirySeconds * 1000,
    ).toISOString();

    return {
      invoice: `lnbcrt${req.amountSat}n1mock_${paymentHash.slice(0, 16)}`,
      paymentHash,
      expiresAt,
      amountSat: req.amountSat,
    };
  }

  /** Get the preimage for a mock invoice (for test client auto-payment). */
  getPreimage(paymentHash: string): string | undefined {
    return this.preimages.get(paymentHash);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
