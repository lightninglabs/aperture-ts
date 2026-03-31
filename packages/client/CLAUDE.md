# @aperture/client

## Purpose

Buyer-side L402 client SDK. Provides `payingFetch` — a drop-in `fetch()`
wrapper that automatically detects 402 challenges, pays Lightning invoices,
caches L402 tokens, and retries requests with valid credentials.

## Key Types

- `createPayingFetch(config)` — Factory returning a paying fetch function
- `PayingFetchConfig` — Payer, token cache, receipt cache, buyer policy
- `L402Challenge` — Parsed 402 challenge: challengeId, routeId, amountSat, invoice, macaroon
- `TokenCache` — In-memory L402 token cache keyed by host+routeId+method, TTL-based eviction
- `ReceiptCache` — Client-side receipt storage for audit trail
- `MockInvoicePayer` — Test payer that returns registered preimages
- `ManualApprovalPolicy` — Calls user-provided async approval function before paying

## Module Structure

- `src/fetch/` — `payingFetch.ts` (main auto-payment loop), `retry.ts` (L402 header attachment, idempotency)
- `src/challenge/` — `parse402.ts` (parse 402 response from headers + JSON body)
- `src/policy/` — Re-exports from `@aperture/core/policy` + `ManualApprovalPolicy`
- `src/cache/` — `tokenCache.ts` (TTL-based), `receiptCache.ts` (payment audit trail)
- `src/payer/` — `InvoicePayer` interface + `MockInvoicePayer`

## Relationships

- **Depends on**: [`@aperture/core`](../core/CLAUDE.md) (types, BuyerPolicy interface, policy implementations)
- **Depended on by**: Example buyer client (`examples/buyer-client.ts`), end-user applications
- **External**: Standard `fetch()` API

## Invariants

- `payingFetch` retries exactly once after successful payment. No retry loops.
- Token cache evicts expired tokens on read (checks `expiresAt` against `Date.now()`).
- Buyer policy `assertAllowed()` is called before any wallet action — payment is blocked if policy rejects.
- Idempotency keys are auto-generated for non-GET/HEAD requests if not already present.
- Tokens are never cached across sellers or differing scopes (cache key includes host+routeId+method).

## Testing

- `src/challenge/parse402.test.ts` — 3 tests: JSON body parsing, header fallback, non-402 rejection
- `src/cache/tokenCache.test.ts` — 4 tests: store/retrieve, missing key, expiry eviction, cache key format
- `src/fetch/retry.test.ts` — 4 tests: L402 header attachment, idempotency key generation/preservation
- `src/policy/approvals.test.ts` — 2 tests: manual approval allow/reject
- Run: `pnpm --filter @aperture/client test`

## Deep Docs

- [`@aperture/core` CLAUDE.md](../core/CLAUDE.md) — Protocol types and policies this package consumes
- [README.md](../../README.md) — Project overview, payingFetch usage, buyer policy examples
