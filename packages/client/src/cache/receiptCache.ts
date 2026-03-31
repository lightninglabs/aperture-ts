/**
 * Client-side receipt storage for audit trail.
 */

export interface ClientReceipt {
  paymentHash: string;
  amountSat: number;
  invoice: string;
  preimageHex: string;
  url: string;
  timestamp: string;
}

export class ReceiptCache {
  private receipts = new Map<string, ClientReceipt>();

  store(receipt: ClientReceipt): void {
    this.receipts.set(receipt.paymentHash, receipt);
  }

  get(paymentHash: string): ClientReceipt | undefined {
    return this.receipts.get(paymentHash);
  }

  all(): ClientReceipt[] {
    return Array.from(this.receipts.values());
  }

  get size(): number {
    return this.receipts.size;
  }
}
