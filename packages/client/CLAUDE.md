# @lightninglabs/aperture-client

## Purpose

Buyer-side client SDK for paid HTTP. Provides `payingFetch`, a drop-in
`fetch()` wrapper that detects 402 challenges, pays Lightning invoices, caches
the resulting credentials, and retries with them.

It speaks two protocols through one 402 handler. L402 was here first and is
unchanged. The Machine Payments Protocol's `Payment` authentication scheme is
dispatched to when the server's `WWW-Authenticate` carries a Payment
challenge, which is how a seller that speaks both gets to offer both on the
same response. MPP brings two intents: `charge`, a one-shot payment closest
to what L402 already did, and `session`, a prepaid balance spent down over
many requests.

## Key Types

- `createPayingFetch(config)` — Factory returning a paying fetch function
- `PayingFetchConfig` — Payer, token cache, receipt cache, buyer policy
- `L402Challenge` — Parsed 402 challenge: challengeId, routeId, amountSat, invoice, macaroon
- `TokenCache` — In-memory L402 token cache keyed by host+routeId+method, TTL-based eviction
- `ReceiptCache` — Client-side receipt storage for audit trail
- `MockInvoicePayer` — Test payer that returns registered preimages
- `ManualApprovalPolicy` — Calls user-provided async approval function before paying
- `PaymentChallenge` — A parsed MPP offer, discriminated on `charge` or `session`
- `SessionManager` — The session state machine: open, bearer, top up, close
- `SessionRecord` / `SessionStore` — Durable session state, including the deposit preimage a close needs
- `ReturnInvoiceMinter` — Wallet capability for minting the amountless refund invoice a session requires
- `CredentialStore` — Cache for paid Payment credentials, so a retry that throws after payment does not become a second payment

## Module Structure

- `src/fetch/` — `payingFetch.ts` (the 402 handler and the L402 loop), `retry.ts` (Authorization attachment, idempotency)
- `src/challenge/` — `parse402.ts` (L402 402 parsing), `bolt11Amount.ts`, `amountSafety.ts` (bounding the outflow, shared by both protocols)
- `src/mpp/` — `challenge.ts` (reading Payment offers off a 402), `credential.ts` (building the echo and payload), `receipt.ts` (reading and checking `Payment-Receipt`), `sessionManager.ts` (the session state machine), `flow.ts` (the Payment half of the buyer loop), `fixtures.ts` (test-only stub seller)
- `src/policy/` — Re-exports from `@lightninglabs/aperture-core/policy` + `ManualApprovalPolicy`
- `src/cache/` — `tokenCache.ts` (TTL-based), `receiptCache.ts` (payment audit trail), `credentialCache.ts` (paid Payment credentials), `sessionStore.ts` (open sessions)
- `src/payer/` — `InvoicePayer` interface + `MockInvoicePayer`

## Relationships

- **Depends on**: [`@lightninglabs/aperture-core`](../core/CLAUDE.md) (types, BuyerPolicy interface, policy implementations)
- **Depended on by**: Example buyer client (`examples/buyer-client.ts`), end-user applications
- **External**: Standard `fetch()` API

## Invariants

- At most one payment per `payingFetch` call, on every path through either protocol. `PaymentBudget` in `flow.ts` is a tripwire that throws if a second is ever reached.
- `payingFetch` retries exactly once after successful payment. No retry loops. Whatever the retry returns is what the caller gets, 402 included.
- Token cache evicts expired tokens on read (checks `expiresAt` against `Date.now()`).
- Buyer policy `assertAllowed()` is called before any wallet action — payment is blocked if policy rejects.
- Idempotency keys are auto-generated for non-GET/HEAD requests if not already present.
- Tokens are never cached across sellers or differing scopes (cache key includes origin+routeId+method).
- A challenge is echoed back byte for byte. The server recomputes its HMAC over those parameters, so anything the client rewrites is a credential the server refuses.
- A session id is derived from the preimage the wallet obtained, never read out of the challenge. `sha256(preimage)` is the payment hash, and a challenge that names a different one was describing a different invoice.
- Under a session the budget policy is asserted on the deposit at open and top-up, not per request: that is where the money moves, and a bearer request costs nothing at the wallet.
- Opens and top-ups coalesce on the session key. Concurrent requests that all need a session buy one deposit between them.
- A session offer is declined when there is no `ReturnInvoiceMinter`, because a deposit with nowhere for the remainder to go is a deposit that cannot come back.
- The local balance is an estimate. The server prices metered work post hoc, and its number replaces the estimate whenever the two disagree.
- The `source` DID payer identifier is wired but never populated. It is the first field that would make a buyer correlatable across payments, and that is a product decision, not a transport default.

## Testing

- `src/challenge/parse402.test.ts` — L402 402 parsing: JSON body, header fallback, non-402 rejection
- `src/challenge/amountSafety.test.ts` — Bounding the outflow: stated price versus invoice amount, undecodable and amountless invoices
- `src/cache/tokenCache.test.ts`, `src/cache/credentialCache.test.ts` — Store, retrieve, expiry eviction, cache key scoping
- `src/fetch/retry.test.ts` — Authorization attachment, idempotency key generation and preservation
- `src/fetch/payingFetch.test.ts` — L402 loop: body replay, double-pay guard, post-payment store failures
- `src/fetch/mppFetch.test.ts` — The Payment loop end to end against a stub seller: charge, session open, bearer, top-up, close, recovery from each problem type, concurrency, and coexistence with L402
- `src/mpp/challenge.test.ts`, `src/mpp/credential.test.ts`, `src/mpp/receipt.test.ts` — Offer parsing and selection, credential echo fidelity, receipt checking
- `src/mpp/sessionManager.test.ts` — The state machine: deposit coalescing, payment-hash derivation, policy assertion, refunds, close ordering
- Run: `pnpm --filter @lightninglabs/aperture-client test`

## Deep Docs

- [`@lightninglabs/aperture-core` CLAUDE.md](../core/CLAUDE.md) — Protocol types and policies this package consumes
- [README.md](../../README.md) — Project overview, payingFetch usage, buyer policy examples
