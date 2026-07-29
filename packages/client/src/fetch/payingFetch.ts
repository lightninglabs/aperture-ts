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
import { paymentHashFromPreimage } from "@aperture/core/util";
import { parse402Response } from "../challenge/parse402.js";
import {
  TokenCache,
  type CachedToken,
  type TokenStore,
} from "../cache/tokenCache.js";
import { ReceiptCache, type ReceiptStore } from "../cache/receiptCache.js";
import { attachL402Header, ensureIdempotencyKey } from "./retry.js";

export interface PayingFetchConfig {
  payer: InvoicePayer;

  /**
   * Storage for paid L402 tokens. Defaults to a process-local in-memory
   * cache; inject a durable implementation so paid bundles survive process
   * restarts instead of being re-purchased.
   */
  tokenCache?: TokenStore;

  /**
   * Sink for payment receipts. Defaults to a process-local in-memory cache;
   * inject a durable ledger for a spend audit trail.
   */
  receiptCache?: ReceiptStore;

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
    const incoming = new Request(input, init);

    // Buffer the request body once up front. A Request body is a one-shot
    // stream: after the first fetch consumes it, the L402 retry could not
    // re-send it. Every request below is rebuilt from these bytes so the
    // first attempt and the paid retry send identical payloads.
    const bodyBytes =
      incoming.body === null ? null : await incoming.arrayBuffer();

    // Carry the caller's request-shaping fields (notably the AbortSignal)
    // onto every rebuilt request. Without the signal a caller aborting
    // mid-stream would not cancel the fetch, and the wallet could pay for
    // an abandoned request.
    let request = new Request(incoming.url, {
      method: incoming.method,
      headers: incoming.headers,
      body: bodyBytes ?? undefined,
      redirect: incoming.redirect,
      signal: incoming.signal,
      credentials: incoming.credentials,
      mode: incoming.mode,
      cache: incoming.cache,
      integrity: incoming.integrity,
      keepalive: incoming.keepalive,
    });
    request = ensureIdempotencyKey(request, bodyBytes);

    // Key tokens by the full origin (scheme://host[:port]), not the bare
    // hostname: two proxies on different ports of the same host mint
    // unrelated tokens, and a plaintext origin must never share a credential
    // with a TLS one.
    const url = new URL(request.url);
    const cacheKey = TokenCache.cacheKey(
      url.origin,
      init?.routeId ?? url.pathname,
      request.method,
    );

    // Step 1: Check cache.
    const cached = await tokenCache.get(cacheKey);
    const firstRequest = cached
      ? attachL402Header(
          request,
          cached.macaroonB64,
          cached.preimageHex,
          bodyBytes,
        )
      : request;

    // Step 2: First fetch.
    const firstResponse = await fetch(firstRequest);

    if (firstResponse.status !== 402) {
      return firstResponse;
    }

    // Step 3: Parse challenge.
    const challenge = await parse402Response(firstResponse);

    // Step 4: Refuse to pay any invoice whose outflow cannot be bounded. A
    // null amount means an invoice was present but its amount could not be
    // decoded; a 0 amount means a genuine zero-amount invoice. In both
    // cases the payer cannot bound the outflow, so paying would let the
    // seller name an arbitrary price after the fact. Both are refused by
    // default rather than passed to the budget policy as a free payment.
    if (challenge.amountSat === null) {
      throw new Error(
        "L402 challenge invoice amount could not be decoded; " +
          "refusing to pay an unbounded outflow",
      );
    }
    if (challenge.amountSat <= 0) {
      throw new Error(
        "L402 challenge specifies a zero-amount invoice; refusing to pay " +
          "an unbounded outflow",
      );
    }
    const amountSat = challenge.amountSat;

    // Step 5: Assert buyer policy.
    if (config.buyerPolicy) {
      await config.buyerPolicy.assertAllowed({
        url: request.url,
        host: url.hostname,
        amountSat,
        routeId: challenge.routeId || undefined,
      });
    }

    // Step 6: Pay invoice. Re-check the abort signal first: the caller may
    // have aborted while the policy was resolving, and the wallet must not
    // spend on a request that has already been abandoned.
    if (request.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const payment = await config.payer.payInvoice({
      invoice: challenge.invoice,
      amountSat,
      challengeId: challenge.challengeId,
    });

    // Step 7: Record the receipt and cache the token. Both happen before
    // the retry: money has already moved, so a retry that throws must not
    // lose the credential or the record of the spend. The payment hash is
    // derived from the preimage itself (sha256(preimage) == payment_hash),
    // making every receipt a self-contained proof of payment.
    //
    // The two writes are independent and neither may abort the request:
    // the credential is in hand, so serving the response the user paid
    // for beats failing on a durable-store error. A failed write degrades
    // to at worst re-purchasing one bundle (token) or a gap in the local
    // ledger (receipt), both bounded; failing here would waste the whole
    // payment.
    const token: CachedToken = {
      macaroonB64: challenge.macaroon,
      preimageHex: payment.preimageHex,
      expiresAt: challenge.expiresAt,
    };

    // Derive the payment hash outside the receipt write, so a malformed
    // preimage from a buggy payer cannot take the whole receipt down with
    // it: a spend record with an empty hash still beats no record at all.
    let paymentHash = "";
    try {
      paymentHash = await paymentHashFromPreimage(payment.preimageHex);
    } catch (err) {
      console.warn("payingFetch: unhashable payment preimage:", err);
    }

    const writes = await Promise.allSettled([
      (async () =>
        receiptCache.store({
          paymentHash,
          amountSat,
          paidSat: payment.amountPaidSat,
          invoice: challenge.invoice,
          preimageHex: payment.preimageHex,
          url: request.url,
          timestamp: new Date().toISOString(),
        }))(),
      (async () => tokenCache.put(cacheKey, token))(),
    ]);
    for (const write of writes) {
      if (write.status === "rejected") {
        console.warn("payingFetch: post-payment store failed:", write.reason);
      }
    }

    // Step 8: Retry with L402.
    const retryRequest = attachL402Header(
      request,
      challenge.macaroon,
      payment.preimageHex,
      bodyBytes,
    );
    return fetch(retryRequest);
  };
}
