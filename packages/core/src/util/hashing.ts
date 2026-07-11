/**
 * SHA-256 hashing and request fingerprinting using Web Crypto API.
 */

/**
 * Compute SHA-256 hash of a string.
 * @returns Hex-encoded hash.
 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Compute a request fingerprint for challenge reuse/idempotency.
 *
 * fingerprint = sha256(sellerId + routeId + method + normalizedPath +
 *   contentType + idempotencyKey)
 */
export async function computeRequestFingerprint(opts: {
  sellerId: string;
  routeId: string;
  method: string;
  path: string;
  contentType?: string;
  idempotencyKey?: string;
}): Promise<string> {
  const parts = [
    opts.sellerId,
    opts.routeId,
    opts.method,
    opts.path,
    opts.contentType ?? "",
    opts.idempotencyKey ?? "",
  ];

  return sha256Hex(parts.join("|"));
}

/**
 * Compute the Lightning payment hash for a payment preimage.
 *
 * The hash is sha256 over the preimage *bytes* (not the hex string), so the
 * result matches the payment_hash the invoice committed to:
 * sha256(preimage) == payment_hash.
 *
 * @param preimageHex Hex-encoded 32-byte payment preimage.
 * @returns Hex-encoded payment hash.
 */
export async function paymentHashFromPreimage(
  preimageHex: string,
): Promise<string> {
  const bytes = hexToBytes(preimageHex);

  // A Lightning preimage is exactly 32 bytes. Hashing anything else would
  // produce a plausible-looking but unverifiable "proof of payment", so a
  // malformed preimage from a buggy payer fails loudly instead.
  if (bytes.length !== 32) {
    throw new Error(
      `payment preimage must be 32 bytes, got ${bytes.length}`,
    );
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid hex string of length ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
