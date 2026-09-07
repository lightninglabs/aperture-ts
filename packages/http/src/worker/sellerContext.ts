/**
 * Seller-side request lifecycle handler per design doc section 15.
 *
 * Flow:
 * 1. Resolve tenant → match route → check isFree.
 * 2. Parse auth header.
 * 3. If no auth or malformed → issue challenge.
 * 4. Verify L402 → if expired/insufficient → re-challenge.
 * 5. Forward to origin → emit receipt via waitUntil.
 */

import {
  parseL402Authorization,
  buildHttp402Challenge,
  matchRoute,
  resolvePrice,
  computeRequestFingerprint,
  getOrCreateIdempotencyKey,
  createReceipt,
} from "@lightninglabs/aperture-core";
import type {
  SellerRuntimeConfig,
  RouteDefinition,
  InvoiceProvider,
  OriginAdapter,
  MacaroonIssuerInterface,
  MacaroonVerifierInterface,
  ReceiptWriter,
  VerifiedL402Context,
  ChallengeState,
  SellerStateStore,
} from "@lightninglabs/aperture-core";
import { ApertureError, errorToResponse } from "./errors.js";

export interface RequestHandlerDeps {
  invoiceProvider: InvoiceProvider;
  originAdapter: OriginAdapter;
  macaroonIssuer: MacaroonIssuerInterface;
  macaroonVerifier: MacaroonVerifierInterface;
  receiptWriter: ReceiptWriter;
  stateStore: SellerStateStore;
}

/**
 * Handle a single request in the context of a resolved seller + route.
 */
export async function handleRequest(
  request: Request,
  seller: SellerRuntimeConfig,
  deps: RequestHandlerDeps,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  // Step 1: Match route.
  const route = matchRoute(request, seller.routes);
  if (!route) {
    return errorToResponse(new ApertureError("route_not_found"));
  }

  // Step 2: Free routes bypass auth.
  if (route.isFree) {
    return deps.originAdapter.execute({ request, seller, route, auth: null });
  }

  // Step 3: Parse auth header.
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return issueChallenge(request, seller, route, deps);
  }

  const parsed = parseL402Authorization(authHeader);
  if (!parsed.ok) {
    return issueChallenge(request, seller, route, deps);
  }

  // Step 4: Verify L402.
  let verified: VerifiedL402Context;
  try {
    verified = await deps.macaroonVerifier.verifyL402(
      parsed.value,
      request,
      seller,
      route,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isExpired = msg.includes("expired");
    if (isExpired || msg.includes("scope")) {
      return issueChallenge(request, seller, route, deps);
    }
    return errorToResponse(new ApertureError("macaroon_invalid", msg));
  }

  // Step 5: Forward to origin.
  const startTime = Date.now();
  const response = await deps.originAdapter.execute({
    request,
    seller,
    route,
    auth: verified,
  });

  // Step 6: Emit receipt asynchronously.
  const durationMs = Date.now() - startTime;
  waitUntil(
    emitReceipt(request, response, seller, route, verified, durationMs, deps),
  );

  return response;
}

async function issueChallenge(
  request: Request,
  seller: SellerRuntimeConfig,
  route: RouteDefinition,
  deps: RequestHandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const idempotencyKey = getOrCreateIdempotencyKey(request);

  // Compute request fingerprint for challenge reuse.
  const fingerprint = await computeRequestFingerprint({
    sellerId: seller.sellerId,
    routeId: route.routeId,
    method: request.method,
    path: url.pathname,
    contentType: request.headers.get("content-type") ?? undefined,
    idempotencyKey,
  });

  // Check for reusable challenge.
  const existing = await deps.stateStore.getOrCreateChallenge(
    seller.sellerId,
    fingerprint,
    idempotencyKey,
  );
  if (existing) {
    return buildHttp402Challenge({
      challengeId: existing.challengeId,
      routeId: existing.routeId,
      amountSat: existing.priceSat,
      invoice: existing.invoice,
      macaroonB64: existing.macaroonB64,
      expiresAt: existing.expiresAt,
    });
  }

  // Resolve price.
  const amountSat = resolvePrice(route.pricing, { request });

  // Create invoice.
  const invoiceResult = await deps.invoiceProvider.createInvoice({
    sellerId: seller.sellerId,
    routeId: route.routeId,
    amountSat,
    memo: `L402 ${route.routeId}`,
    expirySeconds: route.macaroonPolicy.ttlSeconds,
  });

  // Mint macaroon.
  const macaroonB64 = await deps.macaroonIssuer.mintForRoute(
    seller.sellerId,
    route.routeId,
    invoiceResult.paymentHash,
    route.macaroonPolicy,
    request,
  );

  // Generate challenge ID.
  const challengeId = `ch_${crypto.randomUUID().slice(0, 8)}`;

  // Persist challenge state.
  const challengeState: ChallengeState = {
    challengeId,
    sellerId: seller.sellerId,
    routeId: route.routeId,
    requestFingerprint: fingerprint,
    priceSat: amountSat,
    paymentHash: invoiceResult.paymentHash,
    invoice: invoiceResult.invoice,
    macaroonB64,
    createdAt: new Date().toISOString(),
    expiresAt: invoiceResult.expiresAt,
    idempotencyKey,
    status: "issued",
  };

  await deps.stateStore.persistChallenge(challengeState);

  return buildHttp402Challenge({
    challengeId,
    routeId: route.routeId,
    amountSat,
    invoice: invoiceResult.invoice,
    macaroonB64,
    expiresAt: invoiceResult.expiresAt,
  });
}

async function emitReceipt(
  request: Request,
  response: Response,
  seller: SellerRuntimeConfig,
  route: RouteDefinition,
  auth: VerifiedL402Context,
  durationMs: number,
  deps: RequestHandlerDeps,
): Promise<void> {
  const url = new URL(request.url);
  const fingerprint = await computeRequestFingerprint({
    sellerId: seller.sellerId,
    routeId: route.routeId,
    method: request.method,
    path: url.pathname,
  });

  const receipt = createReceipt({
    sellerId: seller.sellerId,
    routeId: route.routeId,
    paymentHash: auth.paymentHash,
    amountSat: 0, // Filled from challenge state if needed.
    invoice: "",
    authorizedAt: new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      host: url.hostname,
      requestFingerprint: fingerprint,
    },
    response: {
      status: response.status,
      durationMs,
    },
    auth: {
      scheme: "L402",
      tokenDigest: auth.paymentHash,
      expiresAt: auth.expiresAt,
    },
  });

  await deps.receiptWriter.writeReceipt(receipt);
}
