/**
 * Bounding the outflow before the wallet is asked to spend.
 *
 * A seller quotes a price and hands over an invoice. The wallet pays what
 * the invoice says, not what the quote says, so the number the buyer policy
 * gets asked about has to be at least what the wallet will actually spend.
 * Every challenge format in this package funnels through here, so the two
 * ways of getting this wrong (trusting a quote the invoice contradicts, and
 * treating an undecodable invoice as free) are fixed in one place.
 */

import { bolt11AmountSat } from "./bolt11Amount.js";

/**
 * Resolve the satoshi amount the buyer policy must assert on.
 *
 * A number is a known bound on the outflow. `null` means an invoice was
 * present but its amount could not be decoded, so the outflow is unbounded
 * and the caller must refuse to pay.
 *
 * When both a seller-stated price and an invoice-encoded amount are
 * available, the larger of the two wins. A materially larger stated price
 * over the invoice is suspicious, but taking the maximum is the safe
 * minimal choice: it never asserts on less than the wallet will spend.
 */
export function resolveAmountSat(
  stated: number,
  invoice: string,
): number | null {
  const decoded = invoice === "" ? undefined : bolt11AmountSat(invoice);

  // An invoice was present but its amount could not be decoded: the outflow
  // is unbounded, so refuse to bound it with the stated price.
  if (decoded === null) return null;

  const statedSat = Number.isFinite(stated) && stated > 0 ? stated : undefined;

  if (decoded !== undefined && statedSat !== undefined) {
    return Math.max(statedSat, decoded);
  }
  if (decoded !== undefined) return decoded;
  if (statedSat !== undefined) return statedSat;

  // Neither an invoice amount nor a stated price is available.
  return 0;
}

/**
 * Narrow a resolved amount to one the wallet may be asked to pay, throwing
 * otherwise.
 *
 * Both rejected cases leave the outflow unbounded: `null` means the invoice
 * amount could not be decoded, and zero or less means a genuine amountless
 * invoice. Neither is passed to the budget policy as a free payment,
 * because doing so would let the seller name its price after the fact.
 */
export function requireBoundedAmount(
  amountSat: number | null,
  context: string,
): number {
  if (amountSat === null) {
    throw new Error(
      `${context}: invoice amount could not be decoded; refusing to pay ` +
        "an unbounded outflow",
    );
  }
  if (amountSat <= 0) {
    throw new Error(
      `${context}: zero-amount invoice; refusing to pay an unbounded ` +
        "outflow",
    );
  }

  return amountSat;
}

/**
 * Parse an amount the protocol carries as a decimal string, as every
 * monetary field in the Payment scheme's request objects does.
 *
 * Returns `undefined` for an absent or unparseable value rather than
 * guessing, so the caller falls back to the invoice, which is the only
 * authoritative statement of what the wallet will spend.
 */
export function parseDecimalSat(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;

  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
