import { describe, it, expect, vi, afterEach } from "vitest";
import { handleRequest, type RequestHandlerDeps } from "./sellerContext.js";
import { createApertureWorkerRuntime } from "./createWorkerRuntime.js";
import { RestInvoiceProvider } from "../invoices/rest.js";
import type { Env } from "../cloudflare/bindings.js";
import type {
  ChallengeState,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
  InvoiceProvider,
  Logger,
  OriginAdapter,
  ReceiptSummary,
  RouteDefinition,
  SellerRuntimeConfig,
  SellerStateStore,
  WorkerRuntimeConfig,
} from "@lightninglabs/aperture-core";

/** The exact body the seller's invoice backend hands back on a failure. */
const BACKEND_BODY = '{"error":"unauthorized","detail":"broker key rejected"}';

/** A hostname the backend might disclose in its failure body. */
const BACKEND_HOST = "broker-internal.seller.example";

function testRoute(): RouteDefinition {
  return {
    routeId: "search",
    match: { pathPrefix: "/v1" },
    challengeMode: "http-402",
    pricing: { kind: "fixed", amountSat: 21 },
    macaroonPolicy: {
      ttlSeconds: 900,
      bindHost: true,
      bindPathPrefix: true,
      bindMethod: true,
      bindRouteId: true,
    },
    backend: { kind: "proxy", target: "" },
  };
}

function testSeller(): SellerRuntimeConfig {
  return {
    sellerId: "seller_1",
    hostnames: ["api.example.com"],
    routes: [testRoute()],
    defaultCurrency: "SAT",
    auth: { scheme: "L402" },
    invoiceBackend: {
      kind: "rest",
      endpoint: `https://${BACKEND_HOST}/invoices`,
      authHeader: "Bearer super-secret-gateway-token",
    },
    origin: { kind: "proxy", baseUrl: "https://origin.example.com" },
    receipts: { mode: "async" },
  };
}

/** A state store that never has a reusable challenge on hand. */
function emptyStateStore(): SellerStateStore {
  return {
    async getOrCreateChallenge(): Promise<ChallengeState | null> {
      return null;
    },
    async persistChallenge(_challenge: ChallengeState): Promise<void> {},
    async writeReceipt(_receipt: ReceiptSummary): Promise<void> {},
  };
}

/** An invoice provider that always fails the way a REST backend does. */
function failingInvoiceProvider(): InvoiceProvider {
  return {
    async createInvoice(
      _req: CreateInvoiceRequest,
    ): Promise<CreateInvoiceResponse> {
      throw new Error(`Invoice backend returned 401: ${BACKEND_BODY}`);
    },
  };
}

function unusedOriginAdapter(): OriginAdapter {
  return {
    async execute(): Promise<Response> {
      throw new Error("origin adapter must not run on a mint failure");
    },
  };
}

function testDeps(
  overrides: Partial<RequestHandlerDeps> = {},
): RequestHandlerDeps {
  return {
    invoiceProvider: failingInvoiceProvider(),
    originAdapter: unusedOriginAdapter(),
    macaroonIssuer: {
      async mintForRoute(): Promise<string> {
        return "macaroon-b64";
      },
    },
    macaroonVerifier: {
      async verifyL402() {
        throw new Error("not used in these tests");
      },
    },
    receiptWriter: {
      async writeReceipt(): Promise<void> {},
    },
    stateStore: emptyStateStore(),
    ...overrides,
  };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (msg: string, ...args: unknown[]): void => {
    lines.push([msg, ...args.map((a) => String(a))].join(" "));
  };
  return {
    lines,
    logger: {
      info: record,
      warn: record,
      error: record,
      debug: record,
    },
  };
}

describe("handleRequest invoice mint failures", () => {
  it("returns 503 when the invoice backend fails", async () => {
    const request = new Request("https://api.example.com/v1/search");

    const response = await handleRequest(
      request,
      testSeller(),
      testDeps(),
      () => {},
    );

    expect(response.status).toBe(503);
  });

  it("does not leak the invoice backend body to the buyer", async () => {
    const request = new Request("https://api.example.com/v1/search");

    const response = await handleRequest(
      request,
      testSeller(),
      testDeps(),
      () => {},
    );

    const raw = await response.text();
    expect(raw).not.toContain(BACKEND_BODY);
    expect(raw).not.toContain("unauthorized");
    expect(raw).not.toContain("broker key rejected");
    expect(raw).not.toContain("Invoice backend returned");

    const body = JSON.parse(raw) as { error: string; message: string };
    expect(body.error).toBe("invoice_backend_unavailable");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("logs the invoice backend detail server-side", async () => {
    const { logger, lines } = recordingLogger();
    const request = new Request("https://api.example.com/v1/search");

    await handleRequest(request, testSeller(), testDeps({ logger }), () => {});

    expect(lines.join("\n")).toContain(BACKEND_BODY);
  });

  it("still issues a normal 402 challenge when the backend works", async () => {
    const request = new Request("https://api.example.com/v1/search");

    const invoiceProvider: InvoiceProvider = {
      async createInvoice(): Promise<CreateInvoiceResponse> {
        return {
          invoice: "lnbcrt210n1testinvoice",
          paymentHash: "a".repeat(64),
          expiresAt: "2030-01-01T00:00:00.000Z",
          amountSat: 21,
        };
      },
    };

    const response = await handleRequest(
      request,
      testSeller(),
      testDeps({ invoiceProvider }),
      () => {},
    );

    expect(response.status).toBe(402);
    expect(response.headers.get("WWW-Authenticate")).toContain("L402");

    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.invoice).toBe("lnbcrt210n1testinvoice");
    expect(body.amount_sat).toBe(21);
    expect(body.macaroon).toBe("macaroon-b64");
  });
});

describe("worker runtime invoice mint failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a generic 503 for a REST backend 401", async () => {
    // Stand in for the seller's invoice backend rejecting our credential.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(BACKEND_BODY, {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const seller = testSeller();
    const config: WorkerRuntimeConfig = {
      tenantResolver: {
        async resolve(): Promise<SellerRuntimeConfig> {
          return seller;
        },
      },
      stateStore: emptyStateStore(),
      invoiceProviderFactory: {
        create(): InvoiceProvider {
          return new RestInvoiceProvider({
            endpoint: seller.invoiceBackend.endpoint!,
            authHeader: seller.invoiceBackend.authHeader,
          });
        },
      },
      macaroonIssuer: {
        async mintForRoute(): Promise<string> {
          return "macaroon-b64";
        },
      },
      macaroonVerifier: {
        async verifyL402() {
          throw new Error("not used in these tests");
        },
      },
      receiptWriter: {
        async writeReceipt(): Promise<void> {},
      },
      originAdapterFactory: {
        create(): OriginAdapter {
          return unusedOriginAdapter();
        },
      },
    };

    const runtime = createApertureWorkerRuntime(config);
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const response = await runtime.fetch(
      new Request("https://api.example.com/v1/search"),
      {} as Env,
      ctx,
    );

    expect(response.status).toBe(503);

    const raw = await response.text();
    expect(raw).not.toContain(BACKEND_BODY);
    expect(raw).not.toContain("unauthorized");
    expect(raw).not.toContain(BACKEND_HOST);
    expect(raw).not.toContain("Invoice backend returned");
    expect(JSON.parse(raw).error).toBe("invoice_backend_unavailable");
  });
});
