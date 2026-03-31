/**
 * Receipt writer implementations.
 */

import type { ReceiptWriter, ApertureReceiptV1 } from "@aperture/core";

/** NoopReceiptWriter: discards receipts (for testing). */
export class NoopReceiptWriter implements ReceiptWriter {
  async writeReceipt(_receipt: ApertureReceiptV1): Promise<void> {}
}

/** InMemoryReceiptWriter: collects receipts in memory (for testing). */
export class InMemoryReceiptWriter implements ReceiptWriter {
  readonly receipts: ApertureReceiptV1[] = [];

  async writeReceipt(receipt: ApertureReceiptV1): Promise<void> {
    this.receipts.push(receipt);
  }
}
