/**
 * Reading and checking the `Payment-Receipt` a server returns after it has
 * verified a payment.
 *
 * A receipt is the server's statement of what it settled. Checking it is
 * worthwhile even though it arrives too late to prevent anything: a receipt
 * that names a different challenge or a different payment than the one the
 * wallet just made is the earliest visible sign that the buyer and seller
 * disagree about what happened, and that disagreement is what a refund
 * later depends on.
 */

import {
  HEADER_PAYMENT_RECEIPT,
  RECEIPT_STATUS_SUCCESS,
  parseReceiptHeader,
  type Receipt,
  type SessionReceipt,
} from "@aperture/core/mpp";

/** What the client believed it was paying for when it sent the credential. */
export interface ReceiptExpectation {
  /** The challenge id echoed in the credential. */
  challengeId?: string;

  /** The payment hash, or the session id, the receipt should reference. */
  reference?: string;

  /** The payment method the challenge named. */
  method?: string;
}

/** A receipt that failed one of the checks, and the reason it failed. */
export interface ReceiptMismatch {
  receipt: Receipt;
  reasons: string[];
}

/**
 * Read the receipt off a response, or null when there is none.
 *
 * A response without a receipt is not an error. Servers issue them on
 * settlement, and a bearer request settles nothing.
 */
export function readReceipt<T extends Receipt = SessionReceipt>(
  response: Response,
): T | null {
  const header = response.headers.get(HEADER_PAYMENT_RECEIPT);
  if (header === null || header === "") return null;

  try {
    return parseReceiptHeader<T>(header);
  } catch {
    // A receipt that will not parse is reported as absent. It cannot be
    // checked, and it is not worth failing a request the caller has
    // already paid for over a malformed audit record.
    return null;
  }
}

/**
 * Check a receipt against what the client believed it paid for, returning
 * the reasons it disagrees. An empty list means the receipt checks out.
 *
 * This returns rather than throws on purpose. By the time a receipt is
 * readable the money has moved and the response is in hand, so failing the
 * request would cost the caller what they paid for without recovering any
 * of it. The reasons belong in a log and in the caller's audit trail; what
 * they must not do is silently disappear.
 */
export function checkReceipt(
  receipt: Receipt,
  expectation: ReceiptExpectation,
): string[] {
  const reasons: string[] = [];

  if (receipt.status !== RECEIPT_STATUS_SUCCESS) {
    reasons.push(
      `receipt status is ${JSON.stringify(receipt.status)}, expected ` +
        `${JSON.stringify(RECEIPT_STATUS_SUCCESS)}`,
    );
  }

  if (expectation.method !== undefined && receipt.method !== expectation.method) {
    reasons.push(
      `receipt method is ${JSON.stringify(receipt.method)}, expected ` +
        `${JSON.stringify(expectation.method)}`,
    );
  }

  // The challenge id is optional in the receipt. When the server does send
  // one, it has to be the challenge we answered.
  if (
    expectation.challengeId !== undefined &&
    receipt.challengeId !== undefined &&
    receipt.challengeId !== expectation.challengeId
  ) {
    reasons.push(
      `receipt settles challenge ${JSON.stringify(receipt.challengeId)}, ` +
        `expected ${JSON.stringify(expectation.challengeId)}`,
    );
  }

  if (
    expectation.reference !== undefined &&
    receipt.reference !== expectation.reference
  ) {
    reasons.push(
      `receipt references ${JSON.stringify(receipt.reference)}, expected ` +
        `${JSON.stringify(expectation.reference)}`,
    );
  }

  return reasons;
}

/** The refund a close receipt reports, when it reports one. */
export interface RefundOutcome {
  refundSats: number;
  refundStatus: string;
}

/**
 * Read the refund a close receipt reports.
 *
 * A close with nothing left to send back is reported as `skipped` with the
 * amount omitted, so an absent `refundSats` alongside a status is zero
 * rather than unknown.
 */
export function readRefund(receipt: SessionReceipt): RefundOutcome | null {
  if (receipt.refundStatus === undefined) return null;

  return {
    refundSats: receipt.refundSats ?? 0,
    refundStatus: receipt.refundStatus,
  };
}
