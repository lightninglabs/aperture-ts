/**
 * Caveat types and builder functions matching the aperture/l402 caveat format.
 *
 * Format: "condition=value"
 * Examples:
 *   seller_id=seller_123
 *   route_id=search_api
 *   payment_hash=abc123...
 *   exp=1711929600
 */

import type { Caveat } from "./wasm.js";

// Re-export the Caveat type from WASM.
export type { Caveat } from "./wasm.js";

// Standard caveat conditions matching aperture/l402/service.go.
export const COND_SERVICES = "services";
export const COND_CAPABILITIES_SUFFIX = "_capabilities";
export const COND_TIMEOUT_SUFFIX = "_valid_until";
export const COND_PREIMAGE = "preimage";

// Aperture-specific conditions for the Worker runtime.
export const COND_SELLER_ID = "seller_id";
export const COND_ROUTE_ID = "route_id";
export const COND_PAYMENT_HASH = "payment_hash";
export const COND_HOST = "host";
export const COND_PATH_PREFIX = "path_prefix";
export const COND_METHOD = "method";
export const COND_TIER = "tier";

/** Encode a caveat to its string form: "condition=value". */
export function encodeCaveat(c: Caveat): string {
  return `${c.condition}=${c.value}`;
}

/** Decode a caveat from "condition=value" format. */
export function decodeCaveat(s: string): Caveat | null {
  const idx = s.indexOf("=");
  if (idx === -1) return null;
  return { condition: s.slice(0, idx), value: s.slice(idx + 1) };
}

export function sellerIdCaveat(sellerId: string): Caveat {
  return { condition: COND_SELLER_ID, value: sellerId };
}

export function routeIdCaveat(routeId: string): Caveat {
  return { condition: COND_ROUTE_ID, value: routeId };
}

export function paymentHashCaveat(paymentHash: string): Caveat {
  return { condition: COND_PAYMENT_HASH, value: paymentHash };
}

export function expiryCaveat(expiresAtUnix: number): Caveat {
  return {
    condition: COND_TIMEOUT_SUFFIX,
    value: expiresAtUnix.toString(),
  };
}

export function hostCaveat(host: string): Caveat {
  return { condition: COND_HOST, value: host };
}

export function pathPrefixCaveat(pathPrefix: string): Caveat {
  return { condition: COND_PATH_PREFIX, value: pathPrefix };
}

export function methodCaveat(methods: string[]): Caveat {
  return { condition: COND_METHOD, value: methods.join("|") };
}

export function tierCaveat(tier: string): Caveat {
  return { condition: COND_TIER, value: tier };
}

export function servicesCaveat(serviceName: string, tier: number = 0): Caveat {
  return { condition: COND_SERVICES, value: `${serviceName}:${tier}` };
}

export function timeoutCaveat(
  serviceName: string,
  expiresAtUnix: number,
): Caveat {
  return {
    condition: `${serviceName}${COND_TIMEOUT_SUFFIX}`,
    value: expiresAtUnix.toString(),
  };
}

/**
 * Build the standard set of caveats for a route-scoped macaroon.
 */
export function buildRouteCaveats(opts: {
  sellerId: string;
  routeId: string;
  paymentHash: string;
  ttlSeconds: number;
  nowUnix: number;
  host?: string;
  pathPrefix?: string;
  methods?: string[];
  tier?: string;
}): Caveat[] {
  const caveats: Caveat[] = [
    servicesCaveat(opts.routeId),
    sellerIdCaveat(opts.sellerId),
    routeIdCaveat(opts.routeId),
    paymentHashCaveat(opts.paymentHash),
    timeoutCaveat(opts.routeId, opts.nowUnix + opts.ttlSeconds),
  ];

  if (opts.host) caveats.push(hostCaveat(opts.host));
  if (opts.pathPrefix) caveats.push(pathPrefixCaveat(opts.pathPrefix));
  if (opts.methods?.length) caveats.push(methodCaveat(opts.methods));
  if (opts.tier) caveats.push(tierCaveat(opts.tier));

  return caveats;
}
