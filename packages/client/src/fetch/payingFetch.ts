/**
 * payingFetch: auto-paying fetch wrapper per design doc section 16.1.
 *
 * Flow:
 * 1. Check token cache → attach L402 if cached.
 * 2. Fetch.
 * 3. If 402 → parse challenge → assert policy → pay invoice.
 * 4. Cache token → retry with L402 header.
 */

import type { BuyerPolicy, InvoicePayer } from "@aperture/core";
import { parse402Response, type L402Challenge } from "../challenge/parse402.js";
import { TokenCache, type CachedToken } from "../cache/tokenCache.js";
import { ReceiptCache } from "../cache/receiptCache.js";
import { attachL402Header, ensureIdempotencyKey } from "./retry.js";

export interface PayingFetchConfig {
  payer: InvoicePayer;
  tokenCache?: TokenCache;
  receiptCache?: ReceiptCache;
  buyerPolicy?: BuyerPolicy;
}

export type PayingFetchInit = RequestInit & {
  /** Override the route ID for cache key computation. */
  routeId?: string;
};

/**
 * Create a paying fetch function that auto-handles L402 challenges.
 */
export function createPayingFetch(config: PayingFetchConfig) {
  const tokenCache = config.tokenCache ?? new TokenCache();
  const receiptCache = config.receiptCache ?? new ReceiptCache();

  return async function payingFetch(
    input: RequestInfo | URL,
    init?: PayingFetchInit,
  ): Promise<Response> {
    let request = new Request(input, init);
    request = ensureIdempotencyKey(request);

    const url = new URL(request.url);
    const cacheKey = TokenCache.cacheKey(
      url.hostname,
      init?.routeId ?? url.pathname,
      request.method,
    );

    // Step 1: Check cache.
    const cached = tokenCache.get(cacheKey);
    const firstRequest = cached
      ? attachL402Header(request, cached.macaroonB64, cached.preimageHex)
      : request;

    // Step 2: First fetch.
    const firstResponse = await fetch(firstRequest);

    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    // Step 3: Parse challenge.
    const challenge = await parse402Response(firstResponse);

    // Step 4: Assert buyer policy.
    if (config.buyerPolicy) {
      await config.buyerPolicy.assertAllowed({
        url: request.url,
        host: url.hostname,
        amountSat: challenge.amountSat,
        routeId: challenge.routeId || undefined,
      });
    }

    // Step 5: Pay invoice.
    const payment = await config.payer.payInvoice({
      invoice: challenge.invoice,
      amountSat: challenge.amountSat,
      challengeId: challenge.challengeId,
    });

    // Step 6: Cache token.
    const token: CachedToken = {
      macaroonB64: challenge.macaroon,
      preimageHex: payment.preimageHex,
      expiresAt: challenge.expiresAt,
    };
    tokenCache.put(cacheKey, token);

    // Step 7: Retry with L402.
    const retryRequest = attachL402Header(
      request,
      challenge.macaroon,
      payment.preimageHex,
    );
    const retryResponse = await fetch(retryRequest);

    // Store receipt.
    receiptCache.store({
      paymentHash: "", // Would be extracted from challenge in full impl.
      amountSat: challenge.amountSat,
      invoice: challenge.invoice,
      preimageHex: payment.preimageHex,
      url: request.url,
      timestamp: new Date().toISOString(),
    });

    return retryResponse;
  };
}
