/**
 * payingFetch: an auto-paying fetch wrapper.
 *
 * One 402 handler covers two protocols. L402 was here first and is
 * unchanged; the Payment authentication scheme is dispatched to when the
 * server's WWW-Authenticate carries a Payment challenge, which is how a
 * seller that speaks both gets to offer both on the same response.
 *
 * Flow:
 * 1. Attach whatever credential is already paid for: an L402 token, a
 *    Payment credential, or a session bearer.
 * 2. Fetch.
 * 3. On a 402, dispatch on the scheme the server offered.
 * 4. Assert policy, pay once, store the credential, retry exactly once.
 *
 * The two disciplines that carry across both protocols are the ones worth
 * stating: at most one payment per call, and exactly one retry after it.
 * Whatever the retry returns is what the caller gets, 402 included. A
 * client that pays again when the paid request is refused has built a loop
 * with a wallet attached.
 */

import type { BuyerPolicy, InvoicePayer } from "@aperture/core";
import { paymentHashFromPreimage } from "@aperture/core/util";
import { parse402Response } from "../challenge/parse402.js";
import { requireBoundedAmount } from "../challenge/amountSafety.js";
import {
  TokenCache,
  type CachedToken,
  type TokenStore,
} from "../cache/tokenCache.js";
import { ReceiptCache, type ReceiptStore } from "../cache/receiptCache.js";
import {
  CredentialCache,
  type CredentialStore,
} from "../cache/credentialCache.js";
import type { SessionStore, SessionRecord } from "../cache/sessionStore.js";
import { paymentChallengesFromHeaders } from "../mpp/challenge.js";
import { runPaymentFlow } from "../mpp/flow.js";
import {
  SessionManager,
  type CloseOutcome,
  type ReturnInvoiceMinter,
} from "../mpp/sessionManager.js";
import {
  attachAuthorization,
  attachL402Header,
  ensureIdempotencyKey,
} from "./retry.js";
import { toAuthorizationHeader } from "../mpp/credential.js";

/** Configuration for the Payment authentication scheme half of the loop. */
export interface MppConfig {
  /**
   * Which intents to take, most wanted first. A session amortizes the
   * wallet round trip across many requests, so it is preferred when the
   * server offers one and the wallet can mint the refund invoice a session
   * needs.
   */
  intents?: readonly string[];

  /**
   * Where open sessions live. Defaults to a process-local cache, which
   * loses every open deposit on restart; inject a durable store so the
   * refunds stay reachable.
   */
  sessionStore?: SessionStore;

  /**
   * Storage for paid Payment credentials. Defaults to a process-local
   * cache. Its job is to keep a retry that throws after the money moved
   * from turning into a second payment on the next attempt.
   */
  credentialCache?: CredentialStore;

  /** Wallet capability for minting the session's refund invoice. */
  returnInvoiceMinter?: ReturnInvoiceMinter;

  /**
   * Open sessions even when there is no way to mint a return invoice,
   * forfeiting the unspent deposit at close. Off by default; without a
   * minter, session offers are declined and a charge offer is taken
   * instead.
   */
  allowSessionWithoutRefund?: boolean;

  /** Reported when a receipt disagrees with what the client paid for. */
  onReceiptMismatch?: (mismatch: {
    receipt: { reference: string; challengeId?: string };
    reasons: string[];
  }) => void;
}

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

  /** Settings for the Payment authentication scheme. */
  mpp?: MppConfig;
}

export type PayingFetchInit = RequestInit & {
  /** Override the route ID for cache key computation. */
  routeId?: string;
};

/**
 * A paying fetch, plus the session handles a caller needs on the way out.
 *
 * Sessions are the one piece of this client that owns money after a request
 * finishes, so they are reachable rather than hidden: a process that exits
 * without closing its sessions leaves the unspent deposits with the seller
 * until the server's idle timeout decides what to do with them.
 */
export interface PayingFetch {
  (input: RequestInfo | URL, init?: PayingFetchInit): Promise<Response>;

  /** The session state machine, for callers that manage sessions directly. */
  sessions: SessionManager;

  /** Close every open session and collect the refunds. */
  closeSessions(): Promise<CloseOutcome[]>;
}

/**
 * Create a paying fetch that auto-handles L402 and Payment challenges.
 */
export function createPayingFetch(config: PayingFetchConfig): PayingFetch {
  const tokenCache = config.tokenCache ?? new TokenCache();
  const receiptCache = config.receiptCache ?? new ReceiptCache();
  const credentialCache = config.mpp?.credentialCache ?? new CredentialCache();

  const sessions = new SessionManager({
    payer: config.payer,
    ...(config.mpp?.sessionStore === undefined
      ? {}
      : { store: config.mpp.sessionStore }),
    ...(config.mpp?.returnInvoiceMinter === undefined
      ? {}
      : { minter: config.mpp.returnInvoiceMinter }),
    receiptStore: receiptCache,
    ...(config.buyerPolicy === undefined
      ? {}
      : { buyerPolicy: config.buyerPolicy }),
    ...(config.mpp?.allowSessionWithoutRefund === undefined
      ? {}
      : { allowSessionWithoutRefund: config.mpp.allowSessionWithoutRefund }),
    ...(config.mpp?.onReceiptMismatch === undefined
      ? {}
      : { onReceiptMismatch: config.mpp.onReceiptMismatch }),
  });

  const payingFetch = async function payingFetch(
    input: RequestInfo | URL,
    init?: PayingFetchInit,
  ): Promise<Response> {
    const incoming = new Request(input, init);

    // Buffer the request body once up front. A Request body is a one-shot
    // stream: after the first fetch consumes it, the paid retry could not
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

    // Key credentials by the full origin (scheme://host[:port]), not the
    // bare hostname: two proxies on different ports of the same host mint
    // unrelated credentials, and a plaintext origin must never share one
    // with a TLS origin.
    const url = new URL(request.url);
    const routeId = init?.routeId ?? url.pathname;
    const cacheKey = TokenCache.cacheKey(url.origin, routeId, request.method);

    const assertNotAborted = (): void => {
      if (request.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    };

    // Step 1: Attach whatever this client has already paid for.
    const attached = await attachExistingCredential({
      request,
      bodyBytes,
      cacheKey,
      tokenCache,
      credentialCache,
      sessions,
      origin: url.origin,
    });

    // Step 2: First fetch.
    const firstResponse = await fetch(attached.request);
    if (firstResponse.status !== 402) {
      // A bearer request that the server served is a request the server
      // charged for. This is the common case for a session, and the one
      // place a spend happens with no payment to hang the bookkeeping off,
      // so the estimate is drawn down here or it is never drawn down at
      // all.
      const session = attached.session;
      if (
        session !== null &&
        firstResponse.ok &&
        session.pricePerUnitSat !== null
      ) {
        await sessions.recordSpend(session.key, session.pricePerUnitSat);
      }

      return firstResponse;
    }

    // A cached credential the server just refused is spent, or bound to a
    // challenge that is gone. Dropping it costs nothing, and keeping it
    // would spend a wasted round trip on every later request to this route,
    // since a credential the server never gave an expiry for has nothing to
    // age it out.
    if (attached.fromCredentialCache) {
      await credentialCache.delete(cacheKey);
    }

    // Step 3: Dispatch on the scheme the server offered. This reads only
    // headers, because a 402 body can be read once and whoever handles the
    // challenge is the one who needs it.
    const paymentChallenges = paymentChallengesFromHeaders(firstResponse);
    if (paymentChallenges.length > 0) {
      return runPaymentFlow(
        {
          payer: config.payer,
          sessions,
          credentialCache,
          receiptStore: receiptCache,
          ...(config.buyerPolicy === undefined
            ? {}
            : { buyerPolicy: config.buyerPolicy }),
          intents: config.mpp?.intents ?? ["session", "charge"],
          ...(config.mpp?.onReceiptMismatch === undefined
            ? {}
            : { onReceiptMismatch: config.mpp.onReceiptMismatch }),
        },
        {
          challenges: paymentChallenges,
          response: firstResponse,
          url: request.url,
          origin: url.origin,
          credentialKey: cacheKey,
          attemptedSession: attached.session,
          retry: async (authorization: string) =>
            fetch(attachAuthorization(request, authorization, bodyBytes)),
          assertNotAborted,
        },
      );
    }

    // A session credential that the server answered with something other
    // than a Payment challenge tells us nothing about the session, so the
    // response goes back as-is rather than being guessed at.
    return runL402Flow({
      config,
      request,
      url,
      bodyBytes,
      cacheKey,
      tokenCache,
      receiptCache,
      response: firstResponse,
      assertNotAborted,
    });
  } as PayingFetch;

  payingFetch.sessions = sessions;
  payingFetch.closeSessions = async (): Promise<CloseOutcome[]> =>
    sessions.closeAll(async ({ url: closeUrl, authorization }) =>
      fetch(
        new Request(closeUrl, {
          method: "GET",
          headers: { Authorization: authorization },
        }),
      ),
    );

  return payingFetch;
}

/** What `attachExistingCredential` decided to present, and on what. */
interface AttachedCredential {
  request: Request;

  /**
   * The session whose bearer credential was attached, or null when
   * something else was. Only a request that actually carried a bearer
   * credential can have that credential refused, so the rest of the loop
   * reads this rather than merely whether a session exists.
   */
  session: SessionRecord | null;

  /** Whether the credential came out of the paid-credential cache. */
  fromCredentialCache: boolean;
}

/**
 * Attach the credential this client already holds for a request, if any.
 *
 * Only one Authorization header can be sent, so the order is most specific
 * first: a credential paid for this exact origin, route, and method beats a
 * session bearer, which is scoped to the whole origin and was found by
 * guessing at the realm. Preferring the session would mean an origin that
 * serves both protocols could present a bearer credential on a route it has
 * a paid L402 token for, get refused, and buy the token a second time.
 */
async function attachExistingCredential(input: {
  request: Request;
  bodyBytes: ArrayBuffer | null;
  cacheKey: string;
  tokenCache: TokenStore;
  credentialCache: CredentialStore;
  sessions: SessionManager;
  origin: string;
}): Promise<AttachedCredential> {
  const paid = await input.credentialCache.get(input.cacheKey);
  if (paid !== null && paid !== undefined) {
    return {
      request: attachAuthorization(
        input.request,
        paid.authorization,
        input.bodyBytes,
      ),
      session: null,
      fromCredentialCache: true,
    };
  }

  const token = await input.tokenCache.get(input.cacheKey);
  if (token !== null && token !== undefined) {
    return {
      request: attachL402Header(
        input.request,
        token.macaroonB64,
        token.preimageHex,
        input.bodyBytes,
      ),
      session: null,
      fromCredentialCache: false,
    };
  }

  const session = await input.sessions.findForOrigin(input.origin);
  if (session !== null) {
    const credential = input.sessions.bearerCredential(session);
    return {
      request: attachAuthorization(
        input.request,
        toAuthorizationHeader(credential),
        input.bodyBytes,
      ),
      session,
      fromCredentialCache: false,
    };
  }

  return { request: input.request, session: null, fromCredentialCache: false };
}

/**
 * The original L402 buyer loop, unchanged in behavior and moved here so the
 * two protocols read as siblings rather than as one wrapped in the other.
 */
async function runL402Flow(input: {
  config: PayingFetchConfig;
  request: Request;
  url: URL;
  bodyBytes: ArrayBuffer | null;
  cacheKey: string;
  tokenCache: TokenStore;
  receiptCache: ReceiptStore;
  response: Response;
  assertNotAborted: () => void;
}): Promise<Response> {
  const { config, request, bodyBytes, tokenCache, receiptCache } = input;

  const challenge = await parse402Response(input.response);

  // Refuse to pay any invoice whose outflow cannot be bounded, whether
  // because the amount would not decode or because the invoice carries no
  // amount at all. Either way the seller could name its price after the
  // fact, so neither is passed to the budget policy as a free payment.
  const amountSat = requireBoundedAmount(challenge.amountSat, "L402 challenge");

  if (config.buyerPolicy) {
    await config.buyerPolicy.assertAllowed({
      url: request.url,
      host: input.url.hostname,
      amountSat,
      routeId: challenge.routeId || undefined,
    });
  }

  // Re-check the abort signal: the caller may have aborted while the policy
  // was resolving, and the wallet must not spend on a request that has
  // already been abandoned.
  input.assertNotAborted();

  const payment = await config.payer.payInvoice({
    invoice: challenge.invoice,
    amountSat,
    challengeId: challenge.challengeId,
  });

  // Record the receipt and cache the token. Both happen before the retry:
  // money has already moved, so a retry that throws must not lose the
  // credential or the record of the spend. The payment hash is derived from
  // the preimage itself (sha256(preimage) == payment_hash), making every
  // receipt a self-contained proof of payment.
  //
  // The two writes are independent and neither may abort the request: the
  // credential is in hand, so serving the response the user paid for beats
  // failing on a durable-store error. A failed write degrades to at worst
  // re-purchasing one bundle (token) or a gap in the local ledger
  // (receipt), both bounded; failing here would waste the whole payment.
  const token: CachedToken = {
    macaroonB64: challenge.macaroon,
    preimageHex: payment.preimageHex,
    expiresAt: challenge.expiresAt,
  };

  // Derive the payment hash outside the receipt write, so a malformed
  // preimage from a buggy payer cannot take the whole receipt down with it:
  // a spend record with an empty hash still beats no record at all.
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
    (async () => tokenCache.put(input.cacheKey, token))(),
  ]);
  for (const write of writes) {
    if (write.status === "rejected") {
      console.warn("payingFetch: post-payment store failed:", write.reason);
    }
  }

  const retryRequest = attachL402Header(
    request,
    challenge.macaroon,
    payment.preimageHex,
    bodyBytes,
  );
  return fetch(retryRequest);
}
