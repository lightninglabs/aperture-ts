/**
 * Example: Paid REST API on Cloudflare Workers with L402.
 *
 * One paid route (/v1/search, 10 sats) and one free route (/health).
 */

import {
  createApertureWorkerRuntime,
  StaticTenantResolver,
  MockInvoiceProvider,
  LocalWorkerHandlerAdapter,
  NoopReceiptWriter,
  createWorkerExport,
} from "@lightninglabs/aperture-http";
import { MacaroonIssuer, MacaroonVerifier, initWasm } from "@lightninglabs/aperture-core/macaroon";
import type { Env } from "@lightninglabs/aperture-http";
import type { SellerRuntimeConfig, SellerStateStore, ChallengeState, ReceiptSummary } from "@lightninglabs/aperture-core";

// Simple in-memory state store for demo.
const challengeStore = new Map<string, ChallengeState>();
const stateStore: SellerStateStore = {
  async getOrCreateChallenge(_sellerId, fingerprint) {
    return challengeStore.get(fingerprint) ?? null;
  },
  async persistChallenge(challenge) {
    challengeStore.set(challenge.requestFingerprint, challenge);
  },
  async writeReceipt(_receipt: ReceiptSummary) {},
};

const sellerConfig: SellerRuntimeConfig = {
  sellerId: "demo_seller",
  hostnames: ["localhost"],
  defaultCurrency: "SAT",
  auth: { scheme: "L402" },
  invoiceBackend: { kind: "mock" },
  origin: { kind: "local" },
  receipts: { mode: "async" },
  routes: [
    {
      routeId: "health",
      match: { pathPrefix: "/health" },
      challengeMode: "http-402",
      pricing: { kind: "fixed", amountSat: 0 },
      macaroonPolicy: { ttlSeconds: 900, bindHost: true, bindPathPrefix: true, bindMethod: true, bindRouteId: true },
      backend: { kind: "local" },
      isFree: true,
    },
    {
      routeId: "search_api",
      match: { pathPrefix: "/v1/search", method: ["POST"] },
      challengeMode: "http-402",
      pricing: { kind: "fixed", amountSat: 10 },
      macaroonPolicy: { ttlSeconds: 900, bindHost: true, bindPathPrefix: true, bindMethod: true, bindRouteId: true },
      backend: { kind: "local", target: "/v1/search" },
    },
  ],
};

// Local handler for demo.
const handler = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }
  return Response.json({ results: ["result1", "result2"], query: url.searchParams.get("q") });
};

const MASTER_KEY = "0".repeat(64); // Demo only — use env secret in production.

const runtime = createApertureWorkerRuntime({
  tenantResolver: new StaticTenantResolver(sellerConfig),
  stateStore,
  invoiceProviderFactory: { create: () => new MockInvoiceProvider() },
  macaroonIssuer: new MacaroonIssuer(MASTER_KEY),
  macaroonVerifier: new MacaroonVerifier(MASTER_KEY),
  receiptWriter: new NoopReceiptWriter(),
  originAdapterFactory: { create: () => new LocalWorkerHandlerAdapter(handler) },
});

export default createWorkerExport(runtime);
