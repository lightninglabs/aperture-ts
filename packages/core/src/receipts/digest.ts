/**
 * Receipt digest computation for integrity verification.
 */

import type { ApertureReceiptV1 } from "../types.js";

/**
 * Compute a SHA-256 digest of a receipt for integrity verification.
 *
 * @returns Hex-encoded SHA-256 hash of the receipt JSON.
 */
export async function computeReceiptDigest(
  receipt: ApertureReceiptV1,
): Promise<string> {
  const json = JSON.stringify(receipt);
  const encoded = new TextEncoder().encode(json);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
