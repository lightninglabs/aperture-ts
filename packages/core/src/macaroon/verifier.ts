/**
 * MacaroonVerifier: verifies L402 credentials (macaroon + preimage).
 * Wraps the WASM verifyMacaroon and verifyCaveats functions.
 *
 * Verification algorithm (design doc section 12.4):
 * 1. Derive seller key from master key.
 * 2. Verify macaroon HMAC-chain signature against derived key.
 * 3. Decode identifier to extract payment hash.
 * 4. Verify sha256(preimage) == payment hash.
 * 5. Verify route/host/path/method/expiry caveats.
 * 6. Return verified auth context.
 */

import type {
  MacaroonVerifierInterface,
  ParsedL402Authorization,
  VerifiedL402Context,
  SellerRuntimeConfig,
  RouteDefinition,
} from "../types.js";
import { getWasm } from "./wasm.js";
import { deriveSellerKey } from "./keyDerivation.js";
import {
  COND_SELLER_ID,
  COND_ROUTE_ID,
  COND_PAYMENT_HASH,
  COND_TIER,
  COND_TIMEOUT_SUFFIX,
} from "./caveats.js";

export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "macaroon_invalid"
      | "preimage_invalid"
      | "credential_expired"
      | "insufficient_scope",
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

export class MacaroonVerifier implements MacaroonVerifierInterface {
  private readonly masterKeyHex: string;

  constructor(masterKeyHex: string) {
    this.masterKeyHex = masterKeyHex;
  }

  async verifyL402(
    parsed: ParsedL402Authorization,
    request: Request,
    seller: SellerRuntimeConfig,
    route: RouteDefinition,
  ): Promise<VerifiedL402Context> {
    const wasm = getWasm();

    // Step 1: Derive seller key.
    const rootKeyHex = await deriveSellerKey(
      this.masterKeyHex,
      seller.sellerId,
    );

    const macaroonB64 = parsed.macaroonsB64[0]!;

    // Step 2: Verify macaroon signature.
    const sigResult = wasm.verifyMacaroon(rootKeyHex, macaroonB64);
    if (!sigResult.valid) {
      throw new VerificationError(
        sigResult.error ?? "Macaroon signature verification failed",
        "macaroon_invalid",
      );
    }

    // Step 3: Verify preimage matches payment hash in the macaroon.
    const paymentHashCaveat = sigResult.caveats?.find(
      (c) => c.condition === COND_PAYMENT_HASH,
    );
    if (!paymentHashCaveat) {
      throw new VerificationError(
        "Macaroon missing payment_hash caveat",
        "macaroon_invalid",
      );
    }

    // Step 4: sha256(preimage) == paymentHash.
    const preimageValid = wasm.verifyPreimage(
      parsed.preimageHex,
      paymentHashCaveat.value,
    );
    if (!preimageValid) {
      throw new VerificationError(
        "Preimage does not match payment hash",
        "preimage_invalid",
      );
    }

    // Step 5: Verify caveats (services + timeout).
    const nowUnix = Math.floor(Date.now() / 1000);
    const caveatResult = wasm.verifyCaveats(
      macaroonB64,
      rootKeyHex,
      route.routeId,
      nowUnix,
    );

    if (!caveatResult.valid) {
      const isExpired = caveatResult.error?.includes("expired");
      throw new VerificationError(
        caveatResult.error ?? "Caveat verification failed",
        isExpired ? "credential_expired" : "insufficient_scope",
      );
    }

    // Extract context from caveats.
    const caveats = sigResult.caveats ?? [];
    const sellerIdCav = caveats.find((c) => c.condition === COND_SELLER_ID);
    const routeIdCav = caveats.find((c) => c.condition === COND_ROUTE_ID);
    const tierCav = caveats.find((c) => c.condition === COND_TIER);
    const expCav = caveats.find((c) =>
      c.condition.endsWith(COND_TIMEOUT_SUFFIX),
    );

    return {
      sellerId: sellerIdCav?.value ?? seller.sellerId,
      routeId: routeIdCav?.value ?? route.routeId,
      paymentHash: paymentHashCaveat.value,
      tier: tierCav?.value,
      expiresAt: expCav
        ? new Date(parseInt(expCav.value, 10) * 1000).toISOString()
        : "",
      rawMacaroonB64: macaroonB64,
      rawPreimageHex: parsed.preimageHex,
    };
  }
}
