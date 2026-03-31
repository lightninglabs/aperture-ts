/**
 * Retry logic: single retry after payment with idempotency key preservation.
 */

/**
 * Attach an L402 Authorization header to a request.
 */
export function attachL402Header(
  request: Request,
  macaroonB64: string,
  preimageHex: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `L402 ${macaroonB64}:${preimageHex}`);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
}

/**
 * Ensure an idempotency key exists on non-GET requests.
 */
export function ensureIdempotencyKey(request: Request): Request {
  if (request.method === "GET" || request.method === "HEAD") return request;
  if (request.headers.has("Idempotency-Key")) return request;

  const key = crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", key);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
}
