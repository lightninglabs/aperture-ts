/**
 * ProxyOriginAdapter: forwards authorized requests to an external origin.
 * Design doc section 18.2.
 */

import type {
  OriginAdapter,
  OriginExecutionInput,
  VerifiedL402Context,
} from "@aperture/core";

export class ProxyOriginAdapter implements OriginAdapter {
  constructor(private readonly baseUrl: string) {}

  async execute(input: OriginExecutionInput): Promise<Response> {
    const originUrl = new URL(input.request.url);
    const target = new URL(this.baseUrl);

    // Rewrite the URL to the origin.
    originUrl.hostname = target.hostname;
    originUrl.port = target.port;
    originUrl.protocol = target.protocol;

    // If the backend target specifies a path, use it as prefix.
    if (input.route.backend.target) {
      originUrl.pathname = input.route.backend.target + originUrl.pathname;
    }

    // Clone the request with the new URL.
    const headers = new Headers(input.request.headers);

    // Strip internal challenge headers.
    headers.delete("WWW-Authenticate");

    // Attach verified auth context headers if authenticated.
    if (input.auth) {
      attachAuthHeaders(headers, input.auth);
    }

    const originRequest = new Request(originUrl.toString(), {
      method: input.request.method,
      headers,
      body: input.request.body,
      redirect: "manual",
    });

    return fetch(originRequest);
  }
}

function attachAuthHeaders(
  headers: Headers,
  auth: VerifiedL402Context,
): void {
  headers.set("X-Aperture-Seller-Id", auth.sellerId);
  headers.set("X-Aperture-Route-Id", auth.routeId);
  headers.set("X-Aperture-Payment-Hash", auth.paymentHash);
  if (auth.tier) headers.set("X-Aperture-Tier", auth.tier);
}
