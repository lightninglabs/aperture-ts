/**
 * Retry logic: single retry after payment with idempotency key preservation.
 *
 * Both helpers rebuild requests from pre-buffered body bytes rather than
 * passing `request.body` through. A Request body is a one-shot stream: once
 * the first fetch has consumed it, re-sending it on the retry either throws
 * or transmits an empty body. Buffering also sidesteps Node's requirement
 * that stream-bodied Requests set `duplex: "half"`.
 */

/**
 * Copy the request-shaping init fields that a rebuilt Request must carry
 * over from the caller's original request. Dropping any of these silently
 * changes fetch semantics: losing `signal` means a caller aborting
 * mid-stream no longer cancels the fetch, so the wallet can pay for an
 * abandoned request.
 */
function forwardedInit(request: Request): RequestInit {
  return {
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
    credentials: request.credentials,
    mode: request.mode,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
  };
}

/**
 * Attach an L402 Authorization header to a request.
 *
 * The `body` parameter carries the pre-buffered request body; pass `null`
 * for bodyless requests such as GET and HEAD. It is required so that a
 * caller cannot accidentally rebuild a bodyless request by using the old
 * arity.
 */
export function attachL402Header(
  request: Request,
  macaroonB64: string,
  preimageHex: string,
  body: ArrayBuffer | null,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `L402 ${macaroonB64}:${preimageHex}`);
  return new Request(request.url, {
    ...forwardedInit(request),
    headers,
    body: body ?? undefined,
  });
}

/**
 * Ensure an idempotency key exists on non-GET requests.
 *
 * The `body` parameter carries the pre-buffered request body; pass `null`
 * for bodyless requests. It is required so that a caller cannot
 * accidentally rebuild a bodyless request by using the old arity.
 */
export function ensureIdempotencyKey(
  request: Request,
  body: ArrayBuffer | null,
): Request {
  if (request.method === "GET" || request.method === "HEAD") return request;
  if (request.headers.has("Idempotency-Key")) return request;

  const key = crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", key);
  return new Request(request.url, {
    ...forwardedInit(request),
    headers,
    body: body ?? undefined,
  });
}

/**
 * Attach an arbitrary Authorization header to a request, used by the
 * Payment authentication scheme, whose credential is a single opaque
 * header value rather than a pair of fields.
 *
 * The `body` parameter carries the pre-buffered request body; pass `null`
 * for bodyless requests such as GET and HEAD. It is required so that a
 * caller cannot accidentally rebuild a bodyless request by using the old
 * arity.
 */
export function attachAuthorization(
  request: Request,
  authorization: string,
  body: ArrayBuffer | null,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", authorization);
  return new Request(request.url, {
    ...forwardedInit(request),
    headers,
    body: body ?? undefined,
  });
}
