/**
 * Example: Paid MCP tool server gated by L402 on Cloudflare Workers.
 *
 * Uses HTTP 402 transport-level challenge for MCP tool invocations.
 */

import {
  createApertureWorkerRuntime,
  StaticTenantResolver,
  MockInvoiceProvider,
  LocalWorkerHandlerAdapter,
  NoopReceiptWriter,
  createWorkerExport,
} from "@lightninglabs/aperture-http";
import { MacaroonIssuer, MacaroonVerifier } from "@lightninglabs/aperture-core/macaroon";
import type { SellerRuntimeConfig, SellerStateStore, ChallengeState, ReceiptSummary } from "@lightninglabs/aperture-core";

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
  sellerId: "mcp_demo_seller",
  hostnames: ["localhost"],
  defaultCurrency: "SAT",
  auth: { scheme: "L402" },
  invoiceBackend: { kind: "mock" },
  origin: { kind: "local" },
  receipts: { mode: "async" },
  routes: [
    {
      routeId: "mcp_tool",
      match: { pathPrefix: "/mcp", method: ["POST"], contentTypePrefix: ["application/json"] },
      challengeMode: "http-402",
      pricing: { kind: "fixed", amountSat: 5 },
      macaroonPolicy: { ttlSeconds: 300, bindHost: true, bindPathPrefix: true, bindMethod: true, bindRouteId: true },
      backend: { kind: "local" },
    },
  ],
};

const handler = async (request: Request) => {
  const body = await request.json() as { method?: string; params?: unknown };
  return Response.json({
    jsonrpc: "2.0",
    result: { content: [{ type: "text", text: `MCP tool executed: ${body.method}` }] },
    id: 1,
  });
};

const MASTER_KEY = "0".repeat(64);

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
