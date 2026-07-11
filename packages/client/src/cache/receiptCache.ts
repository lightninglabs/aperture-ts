/**
 * Client-side receipt storage for the payment audit trail: the ReceiptStore
 * contract the paying fetch writes to, and the default in-memory
 * implementation.
 */

export interface ClientReceipt {
  /** Payment hash the invoice committed to (sha256 of the preimage). */
  paymentHash: string;

  /** Invoice face value in satoshis. */
  amountSat: number;

  /**
   * Amount the payer actually reported spending in satoshis, including any
   * swap or routing fees on top of the invoice face value.
   */
  paidSat: number;

  invoice: string;

  /** Proof of payment: sha256(preimage) equals paymentHash. */
  preimageHex: string;

  url: string;
  timestamp: string;
}

/**
 * ReceiptStore is the sink the paying fetch records settled payments into.
 * Implementations may be synchronous (in-memory) or asynchronous (an
 * append-only ledger on disk); the paying fetch awaits both. Receipts are
 * written as soon as the payment settles, before the paid retry runs, so a
 * failed retry still leaves a record of the spend.
 */
export interface ReceiptStore {
  store(receipt: ClientReceipt): void | Promise<void>;
}

export class ReceiptCache implements ReceiptStore {
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
