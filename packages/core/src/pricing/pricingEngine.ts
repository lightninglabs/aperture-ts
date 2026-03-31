/**
 * Resolve a PricingPolicy to a concrete amount in satoshis for a given request.
 */

import type { PricingPolicy, RouteMatch } from "../types.js";

export interface PricingContext {
  request: Request;
  usageCount?: number;
}

/**
 * Resolve the price in satoshis for a request given a pricing policy.
 */
export function resolvePrice(
  policy: PricingPolicy,
  ctx: PricingContext,
): number {
  switch (policy.kind) {
    case "fixed":
      return policy.amountSat;

    case "per-request":
      return policy.amountSat;

    case "tiered":
      return resolveTieredPrice(policy.tiers, ctx);

    case "free-until":
      return (ctx.usageCount ?? 0) < policy.quota
        ? 0
        : policy.thenAmountSat;

    case "dynamic":
      // Dynamic pricing requires an async call to an external resolver.
      // Return 0 here; the caller should use resolveDynamicPrice() instead.
      throw new Error(
        "Dynamic pricing must be resolved via resolveDynamicPrice()",
      );
  }
}

/**
 * Resolve dynamic pricing by calling an external endpoint.
 */
export async function resolveDynamicPrice(
  policy: Extract<PricingPolicy, { kind: "dynamic" }>,
  ctx: PricingContext,
): Promise<number> {
  const url = new URL(ctx.request.url);

  const response = await fetch(policy.resolver.endpoint, {
    method: policy.resolver.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: url.toString(),
      method: ctx.request.method,
      path: url.pathname,
      host: url.hostname,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dynamic price resolver returned ${response.status}`);
  }

  const result = (await response.json()) as { amountSat: number };
  return result.amountSat;
}

function resolveTieredPrice(
  tiers: PricingPolicy extends { kind: "tiered"; tiers: infer T } ? T : never,
  ctx: PricingContext,
): number {
  const url = new URL(ctx.request.url);

  // Evaluate tier rules in order; first match wins.
  for (const tier of tiers as Array<{
    name: string;
    match?: RouteMatch;
    amountSat: number;
  }>) {
    if (!tier.match) return tier.amountSat;

    if (
      tier.match.method &&
      !tier.match.method.includes(ctx.request.method)
    ) {
      continue;
    }

    if (
      tier.match.pathPrefix &&
      !url.pathname.startsWith(tier.match.pathPrefix)
    ) {
      continue;
    }

    if (tier.match.host && url.hostname !== tier.match.host) {
      continue;
    }

    return tier.amountSat;
  }

  // No tier matched; return 0 (free).
  return 0;
}
