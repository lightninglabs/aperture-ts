/**
 * Seller-side policy types. Re-exports from core types with validation.
 */

import type { MacaroonPolicy } from "../types.js";

export type { MacaroonPolicy } from "../types.js";

/** Validate a macaroon policy for correctness. */
export function validateMacaroonPolicy(policy: MacaroonPolicy): string[] {
  const errors: string[] = [];

  if (policy.ttlSeconds <= 0) {
    errors.push("ttlSeconds must be positive");
  }

  if (
    !policy.bindHost &&
    !policy.bindPathPrefix &&
    !policy.bindMethod &&
    !policy.bindRouteId
  ) {
    errors.push("At least one binding (host, pathPrefix, method, or routeId) should be enabled");
  }

  if (policy.maxUses !== undefined && policy.maxUses <= 0) {
    errors.push("maxUses must be positive when specified");
  }

  return errors;
}
