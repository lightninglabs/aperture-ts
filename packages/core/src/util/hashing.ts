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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
