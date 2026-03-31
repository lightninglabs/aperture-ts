/**
 * Idempotency key generation for non-GET requests.
 */

/**
 * Generate a random idempotency key.
 * @returns Hex-encoded 16-byte random key.
 */
export function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract idempotency key from request, or generate one for non-GET.
 */
export function getOrCreateIdempotencyKey(request: Request): string | undefined {
  const existing = request.headers.get("Idempotency-Key");
  if (existing) return existing;

  // Only generate for non-GET, non-HEAD requests.
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  return generateIdempotencyKey();
}
