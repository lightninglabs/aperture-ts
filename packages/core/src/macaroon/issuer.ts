/**
 * MacaroonIssuer: mints L402 macaroons for route-scoped challenges.
 * Wraps the WASM mintMacaroon function with TypeScript policy logic.
 */

import type {
  MacaroonIssuerInterface,
  MacaroonPolicy,
} from "../types.js";
import { getWasm } from "./wasm.js";
import { deriveSellerKey } from "./keyDerivation.js";
import { buildRouteCaveats } from "./caveats.js";

export class MacaroonIssuer implements MacaroonIssuerInterface {
  private readonly masterKeyHex: string;

  constructor(masterKeyHex: string) {
    this.masterKeyHex = masterKeyHex;
  }

  /**
   * Mint a macaroon scoped to a specific route and payment hash.
   *
   * @returns Base64-encoded macaroon.
   */
  async mintForRoute(
    sellerId: string,
    routeId: string,
    paymentHash: string,
    policy: MacaroonPolicy,
    request: Request,
  ): Promise<string> {
    const wasm = getWasm();

    // Derive per-seller root key.
    const rootKeyHex = await deriveSellerKey(this.masterKeyHex, sellerId);

    const url = new URL(request.url);
    const nowUnix = Math.floor(Date.now() / 1000);

    // Build caveats from policy.
    const caveats = buildRouteCaveats({
      sellerId,
      routeId,
      paymentHash,
      ttlSeconds: policy.ttlSeconds,
      nowUnix,
      host: policy.bindHost ? url.hostname : undefined,
      pathPrefix: policy.bindPathPrefix ? url.pathname : undefined,
      methods: policy.bindMethod ? [request.method] : undefined,
    });

    const result = wasm.mintMacaroon(rootKeyHex, paymentHash, caveats);

    if ("error" in result && typeof result.error === "string") {
      throw new Error(`Failed to mint macaroon: ${result.error}`);
    }

    return result.macaroonB64;
  }
}
