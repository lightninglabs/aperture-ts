# @lightninglabs/aperture-http

## Purpose

Cloudflare Worker runtime for L402-gated APIs. Provides the
`createApertureWorkerRuntime` factory that wires together tenant resolution,
route matching, L402 challenge issuance, credential verification, origin
forwarding, and async receipt emission into a single Worker fetch handler.

## Key Types

- `ApertureWorkerRuntime` — The `{ fetch(request, env, ctx) }` interface returned by the factory
- `WorkerRuntimeConfig` — All injectable dependencies (resolver, issuer, verifier, store, etc.)
- `Env` — CF Worker environment bindings (MACAROON_MASTER_KEY, SELLER_STATE DO, INVOICE_SERVICE, etc.)
- `SellerStateDO` — Durable Object class for per-seller challenge state and receipt summaries
- `SellerStateClient` — Typed stub for calling SellerStateDO from the Worker
- `MockInvoiceProvider` — Generates fake BOLT11 invoices with known preimages for testing
- `RestInvoiceProvider` — Calls an external REST endpoint for invoice creation
- `ProxyOriginAdapter` — Forwards authorized requests to an external origin URL
- `LocalWorkerHandlerAdapter` — Invokes a seller-supplied function inside the Worker
- `ApertureError` — Typed error with `ApertureErrorCode` and HTTP status mapping

## Module Structure

- `src/worker/` — Core runtime: factory (`createWorkerRuntime.ts`), request lifecycle (`sellerContext.ts`), tenant resolution, error model, receipt writer
- `src/cloudflare/` — CF-specific: `Env` bindings, Durable Object (`sellerStateDO.ts`), DO client
- `src/invoices/` — Invoice provider interface + implementations: mock, REST, service-binding
- `src/proxy/` — Origin adapters: proxy forward, local handler
- `src/adapters/` — `workerHandler.ts` wraps runtime into `export default { fetch }` format

## Relationships

- **Depends on**: [`@lightninglabs/aperture-core`](../core/CLAUDE.md) (all protocol types, L402 parsing, challenge building, route matching, pricing, receipts)
- **Depended on by**:
  - [`create-aperture-app`](../create-aperture-app/CLAUDE.md) — templates import runtime factory + adapters
  - Example Workers (`examples/worker-rest-paid-api/`, `examples/worker-mcp-paid-tool/`)
- **External**: CF Workers APIs (Request, Response, ExecutionContext, DurableObject, Fetcher, KVNamespace, Queue)

## Invariants

- The request lifecycle in `sellerContext.ts` follows design doc section 15.1 exactly: resolve → match → free check → parse auth → verify or challenge → forward → receipt.
- Challenge reuse is keyed by request fingerprint (sha256 of sellerId+routeId+method+path+contentType+idempotencyKey). Same fingerprint during invoice validity returns the same challenge.
- Receipt emission uses `ctx.waitUntil()` and must never block the response path.
- DO naming convention: `seller:${sellerId}` for the Durable Object instance name.
- Auth context headers to origin: `X-Aperture-Seller-Id`, `X-Aperture-Route-Id`, `X-Aperture-Payment-Hash`, `X-Aperture-Tier`.

## Testing

- `src/worker/errors.test.ts` — 6 tests: error code → HTTP status mapping
- `src/worker/tenantResolver.test.ts` — 3 tests: static + hostname-based resolution
- `src/invoices/mock.test.ts` — 3 tests: invoice creation, preimage storage, preimage→hash verification
- `src/proxy/localHandler.test.ts` — 2 tests: handler invocation, auth context passing
- Run: `pnpm --filter @lightninglabs/aperture-http test`

## Deep Docs

- [`@lightninglabs/aperture-core` CLAUDE.md](../core/CLAUDE.md) — Protocol types and WASM macaroon ops this package uses
- [`create-aperture-app` CLAUDE.md](../create-aperture-app/CLAUDE.md) — Scaffolding tool using this runtime
- [README.md](../../README.md) — Project overview, seller config model, invoice provider docs
