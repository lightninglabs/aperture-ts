/**
 * Core type definitions for the Aperture TypeScript runtime.
 * Derived from aperture-cloudflare-workers-runtime-design.md sections 9-20.
 */

// ---------------------------------------------------------------------------
// Seller configuration (design doc section 9).
// ---------------------------------------------------------------------------

export interface SellerRuntimeConfig {
  sellerId: string;
  hostnames: string[];
  routes: RouteDefinition[];
  defaultCurrency: "BTC" | "SAT";
  auth: SellerAuthConfig;
  invoiceBackend: InvoiceBackendConfig;
  origin: OriginConfig;
  receipts: ReceiptConfig;
}

export interface SellerAuthConfig {
  scheme: "L402";
}

export interface InvoiceBackendConfig {
  kind: "rest" | "service-binding" | "grpc-bridge" | "mock";
  /** URL for REST adapter, or service binding name. */
  endpoint?: string;
  binding?: string;
  authHeader?: string;
}

export interface OriginConfig {
  kind: "proxy" | "local" | "service-binding";
  baseUrl?: string;
  binding?: string;
}

export interface ReceiptConfig {
  mode: "async" | "sync";
}

// ---------------------------------------------------------------------------
// Route definitions (design doc section 9).
// ---------------------------------------------------------------------------

export interface RouteDefinition {
  routeId: string;
  match: RouteMatch;
  challengeMode: "http-402" | "grpc" | "mcp-response";
  pricing: PricingPolicy;
  macaroonPolicy: MacaroonPolicy;
  backend: BackendTarget;
  isFree?: boolean;
}

export interface RouteMatch {
  host?: string;
  pathPrefix?: string;
  method?: string[];
  contentTypePrefix?: string[];
}

export interface BackendTarget {
  kind: "proxy" | "local" | "service-binding";
  target?: string;
  binding?: string;
}

// ---------------------------------------------------------------------------
// Pricing (design doc section 9).
// ---------------------------------------------------------------------------

export type PricingPolicy =
  | { kind: "fixed"; amountSat: number }
  | { kind: "per-request"; amountSat: number }
  | { kind: "tiered"; tiers: TierRule[] }
  | { kind: "dynamic"; resolver: DynamicPriceResolverConfig }
  | { kind: "free-until"; quota: number; thenAmountSat: number };

export interface TierRule {
  name: string;
  match?: RouteMatch;
  amountSat: number;
}

export interface DynamicPriceResolverConfig {
  endpoint: string;
  method?: string;
}

// ---------------------------------------------------------------------------
// Macaroon policy (design doc section 9).
// ---------------------------------------------------------------------------

export interface MacaroonPolicy {
  ttlSeconds: number;
  bindHost: boolean;
  bindPathPrefix: boolean;
  bindMethod: boolean;
  bindRouteId: boolean;
  maxUses?: number;
  allowDelegation?: boolean;
}

// ---------------------------------------------------------------------------
// Challenge state (design doc section 10.2).
// ---------------------------------------------------------------------------

export interface ChallengeState {
  challengeId: string;
  sellerId: string;
  routeId: string;
  requestFingerprint: string;
  priceSat: number;
  paymentHash: string;
  invoice: string;
  macaroonB64: string;
  createdAt: string;
  expiresAt: string;
  idempotencyKey?: string;
  status: "issued" | "used" | "expired" | "revoked";
}

// ---------------------------------------------------------------------------
// Invoice provider (design doc section 11).
// ---------------------------------------------------------------------------

export interface InvoiceProvider {
  createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResponse>;
  lookupInvoice?(req: LookupInvoiceRequest): Promise<LookupInvoiceResponse>;
}

export interface CreateInvoiceRequest {
  sellerId: string;
  routeId: string;
  amountSat: number;
  memo: string;
  expirySeconds: number;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface CreateInvoiceResponse {
  invoice: string;
  paymentHash: string;
  expiresAt: string;
  amountSat: number;
  backendInvoiceId?: string;
}

export interface LookupInvoiceRequest {
  paymentHash: string;
}

export interface LookupInvoiceResponse {
  settled: boolean;
  settledAt?: string;
}

// ---------------------------------------------------------------------------
// L402 auth types (design doc section 12, 14).
// ---------------------------------------------------------------------------

export interface ParsedL402Authorization {
  scheme: "L402";
  macaroonsB64: string[];
  preimageHex: string;
}

export interface VerifiedL402Context {
  sellerId: string;
  routeId: string;
  paymentHash: string;
  tier?: string;
  expiresAt: string;
  rawMacaroonB64: string;
  rawPreimageHex: string;
}

// ---------------------------------------------------------------------------
// Receipt (design doc section 19).
// ---------------------------------------------------------------------------

export interface ApertureReceiptV1 {
  version: "aperture.receipt.v1";
  receiptId: string;
  sellerId: string;
  routeId: string;
  challengeId?: string;
  paymentHash: string;
  amountSat: number;
  invoice: string;
  authorizedAt: string;
  request: {
    method: string;
    url: string;
    host: string;
    requestFingerprint: string;
  };
  response: {
    status: number;
    durationMs: number;
  };
  auth: {
    scheme: "L402";
    tokenDigest: string;
    expiresAt: string;
  };
}

// ---------------------------------------------------------------------------
// Receipt summary (design doc section 10.3).
// ---------------------------------------------------------------------------

export interface ReceiptSummary {
  receiptId: string;
  sellerId: string;
  routeId: string;
  paymentHash: string;
  amountSat: number;
  requestFingerprint: string;
  authorizedAt: string;
  responseStatus: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Error model (design doc section 20).
// ---------------------------------------------------------------------------

export type ApertureErrorCode =
  | "route_not_found"
  | "payment_required"
  | "invalid_authorization_header"
  | "macaroon_invalid"
  | "preimage_invalid"
  | "credential_expired"
  | "insufficient_scope"
  | "invoice_backend_unavailable"
  | "origin_unavailable"
  | "policy_denied"
  | "internal_error";

// ---------------------------------------------------------------------------
// Worker runtime config (design doc section 8.2).
// ---------------------------------------------------------------------------

export interface WorkerRuntimeConfig {
  tenantResolver: TenantResolver;
  stateStore: SellerStateStore;
  invoiceProviderFactory: InvoiceProviderFactory;
  macaroonIssuer: MacaroonIssuerInterface;
  macaroonVerifier: MacaroonVerifierInterface;
  receiptWriter: ReceiptWriter;
  originAdapterFactory: OriginAdapterFactory;
  clock?: Clock;
  logger?: Logger;
}

export interface TenantResolver {
  resolve(request: Request, env: unknown): Promise<SellerRuntimeConfig>;
}

export interface SellerStateStore {
  getOrCreateChallenge(
    sellerId: string,
    requestFingerprint: string,
    idempotencyKey?: string,
  ): Promise<ChallengeState | null>;

  persistChallenge(challenge: ChallengeState): Promise<void>;

  writeReceipt(receipt: ReceiptSummary): Promise<void>;
}

export interface InvoiceProviderFactory {
  create(config: InvoiceBackendConfig): InvoiceProvider;
}

export interface MacaroonIssuerInterface {
  mintForRoute(
    sellerId: string,
    routeId: string,
    paymentHash: string,
    policy: MacaroonPolicy,
    request: Request,
  ): Promise<string>;
}

export interface MacaroonVerifierInterface {
  verifyL402(
    parsed: ParsedL402Authorization,
    request: Request,
    seller: SellerRuntimeConfig,
    route: RouteDefinition,
  ): Promise<VerifiedL402Context>;
}

export interface ReceiptWriter {
  writeReceipt(receipt: ApertureReceiptV1): Promise<void>;
}

export interface OriginAdapterFactory {
  create(config: OriginConfig): OriginAdapter;
}

export interface OriginAdapter {
  execute(input: OriginExecutionInput): Promise<Response>;
}

export interface OriginExecutionInput {
  request: Request;
  seller: SellerRuntimeConfig;
  route: RouteDefinition;
  auth?: VerifiedL402Context | null;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Buyer policy (design doc section 16.2).
// ---------------------------------------------------------------------------

export interface BuyerPolicy {
  assertAllowed(input: {
    url: string;
    host: string;
    amountSat: number;
    routeId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Invoice payer — buyer side (design doc section 16).
// ---------------------------------------------------------------------------

export interface InvoicePayer {
  payInvoice(input: {
    invoice: string;
    amountSat: number;
    challengeId: string;
  }): Promise<{
    preimageHex: string;
    amountPaidSat: number;
  }>;
}
