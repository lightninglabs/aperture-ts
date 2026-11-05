# @lightninglabs/aperture-core

## Purpose

Shared L402 protocol and policy layer with no framework dependencies. Provides
type definitions, WASM-backed macaroon operations, pricing engine, receipt
schema, route matching, and buyer/seller policy evaluation used by both the
seller-side Worker runtime and the buyer-side client SDK.

## Key Types

- `SellerRuntimeConfig` — Complete seller configuration: routes, pricing, auth, origin, receipts
- `RouteDefinition` — Single route with match rules, pricing policy, macaroon policy, backend target
- `PricingPolicy` — Union type: fixed | per-request | tiered | dynamic | free-until
- `MacaroonPolicy` — TTL, host/path/method/route bindings, optional maxUses
- `ParsedL402Authorization` — Parsed L402 auth header: scheme, macaroonsB64[], preimageHex
- `VerifiedL402Context` — Post-verification context: sellerId, routeId, paymentHash, tier, expiry
- `ApertureReceiptV1` — Versioned receipt with request/response/auth metadata
- `ApertureWasm` — TypeScript interface for the Go WASM bridge (7 functions)
- `BuyerPolicy` — Interface for buyer-side payment policy (budget caps, allowlists)
- `ChallengeParams` / `Credential` / `Receipt` — Machine Payments Protocol wire types for the `Payment` auth scheme
- `SessionRequest` / `SessionPayload` / `SessionReceipt` — draft-lightning-session-00 wire types
- `ChargeRequest` / `ChargePayload` — draft-lightning-charge-00 wire types

## Module Structure

- `src/auth/` — L402 header parsing (`parseAuthorization.ts`), challenge response builder (`challenge.ts`)
- `src/macaroon/` — WASM loader (`wasm.ts`), issuer, verifier, caveats, key derivation
- `src/pricing/` — Pricing engine resolving PricingPolicy → amountSat
- `src/receipts/` — Receipt schema, JSON serialization, SHA-256 digest
- `src/policy/` — Route matching, buyer policies (budget, allowlist, composite), seller policy validation
- `src/mpp/` — Machine Payments Protocol wire layer: JCS canonicalization (`jcs.ts`), base64url (`base64url.ts`), challenge/credential/receipt header codecs (`header.ts`), the challenge-id HMAC binding (`challengeId.ts`), wire types (`types.ts`)
- `src/util/` — SHA-256 hashing, request fingerprinting, idempotency keys, injectable clock
- `src/types.ts` — All shared type definitions from design doc sections 9-20

## Relationships

- **Depends on**: [`@lightninglabs/aperture-wasm`](../wasm/CLAUDE.md) (loads `aperture.wasm` binary at runtime for macaroon mint/verify/caveats)
- **Depended on by**:
  - [`@lightninglabs/aperture-http`](../http/CLAUDE.md) — uses all protocol types, L402 parsing, challenge building, route matching, pricing, receipts
  - [`@lightninglabs/aperture-client`](../client/CLAUDE.md) — uses types, BuyerPolicy interface, policy implementations
  - [`create-aperture-app`](../create-aperture-app/CLAUDE.md) — templates import core types
- **External**: Web Crypto API (HKDF key derivation, SHA-256), Go WASM runtime (`wasm_exec.js`)

## Invariants

- `initWasm(source)` must be called before any macaroon operation (`getWasm()` throws if not initialized). It takes the compiled module or its bytes and requires `globalThis.Go` to already be defined; it never reads from disk. Node callers use `initWasmFromDisk()` from `@lightninglabs/aperture-core/node`, which is the only module in the package that touches Node builtins, so Worker bundles stay free of them.
- The WASM bridge uses `globalThis.apertureWasm` — only one instance can be active per isolate.
- Caveat format is `condition=value` (single `=` delimiter, `SplitN(s, "=", 2)`).
- Service caveat format is `services=name:tier,name2:tier2` matching Go's `encodeServicesCaveatValue`.
- Timeout caveat condition is `{serviceName}_valid_until` with Unix timestamp value.
- Key derivation: `HKDF(masterKey, "seller:{sellerId}:v1")` using SHA-256 with zero salt.
- MPP canonicalization follows RFC 8785 exactly: member names sorted by UTF-16 code unit, strings escaped the way `JSON.stringify` escapes them and no further. It is checked against the vector file aperture's Go `mpp` package generates, which is copied into `testdata/mpp/vectors.json` verbatim and never hand-edited.
- A challenge's `request` and `opaque` are echoed as the strings they arrived as. Re-canonicalizing them client-side would risk changing the bytes the server's HMAC covers.
- The challenge-id HMAC has exactly seven pipe-joined slots: realm, method, intent, request, expires, digest, opaque. `description` is deliberately outside the binding.

## Testing

- `src/macaroon/wasm.test.ts` — 9 tests: mint/verify roundtrip, preimage verification, identifier codec, caveat verification (valid/expired/wrong service)
- `src/macaroon/crosscompat.test.ts` — 3 tests: Go-generated test vectors for cross-language compatibility
- `src/macaroon/caveats.test.ts` — 10 tests: caveat encoding/decoding, builder functions, buildRouteCaveats
- `src/auth/parseAuthorization.test.ts` — 10 tests: valid/invalid/malformed L402 headers
- `src/auth/challenge.test.ts` — 4 tests: 402 response construction, headers, JSON body
- `src/pricing/pricingEngine.test.ts` — 7 tests: all pricing policy types
- `src/policy/routePolicy.test.ts` — 7 tests: path/method/host/wildcard matching
- `src/policy/buyerPolicy.test.ts` — 8 tests: budget cap, window budget, host allowlist, composite
- `src/mpp/jcs.test.ts` — 21 tests: Go-generated canonicalization vectors, the RFC 8785 divergences, and property tests over insertion order, idempotence, key ordering, and injectivity
- `src/mpp/base64url.test.ts` — 11 tests: Go vectors, round trips, and the strictness that keeps a signed value from having two encodings
- `src/mpp/challengeId.test.ts` — 21 tests: Go vectors including empty and oversized secrets, plus tamper detection across every parameter
- `src/mpp/header.test.ts` — 40 tests: Go header/credential/receipt vectors, multi-challenge splitting, quoting, and malformed input
- Run: `pnpm --filter @lightninglabs/aperture-core test`

## Interop

`testdata/mpp/` holds a two-directional harness against the Go reference
implementation: `gen_vectors.go` produces `vectors.json` for the TypeScript
tests to assert on, and `emit_transcript.mjs` plus `verify_transcript.go`
check that a Go seller accepts what the TypeScript buyer emits. See
[`testdata/mpp/README.md`](testdata/mpp/README.md), which also records three
limitations of the reference implementation that the tests pin.

## Deep Docs

- [`@lightninglabs/aperture-wasm` CLAUDE.md](../wasm/CLAUDE.md) — Go WASM bridge this package loads
- [`@lightninglabs/aperture-http` CLAUDE.md](../http/CLAUDE.md) — Worker runtime consuming this package
- [`@lightninglabs/aperture-client` CLAUDE.md](../client/CLAUDE.md) — Buyer SDK consuming this package
- [README.md](../../README.md) — Project overview, architecture diagrams, L402 protocol explanation
