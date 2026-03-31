/**
 * Receipt schema and serialization per design doc section 19.
 */

import type { ApertureReceiptV1 } from "../types.js";

export type { ApertureReceiptV1 } from "../types.js";

/** Create a new receipt with auto-generated ID and version. */
export function createReceipt(
  params: Omit<ApertureReceiptV1, "version" | "receiptId">,
): ApertureReceiptV1 {
  return {
    version: "aperture.receipt.v1",
    receiptId: generateReceiptId(),
    ...params,
  };
}

/** Serialize a receipt to JSON string. */
export function serializeReceipt(receipt: ApertureReceiptV1): string {
  return JSON.stringify(receipt);
}

/** Deserialize a receipt from JSON string. */
export function deserializeReceipt(json: string): ApertureReceiptV1 {
  const parsed = JSON.parse(json) as ApertureReceiptV1;
  if (parsed.version !== "aperture.receipt.v1") {
    throw new Error(`Unknown receipt version: ${parsed.version}`);
  }
  return parsed;
}

function generateReceiptId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
