/**
 * Parse the Authorization header for L402 credentials.
 *
 * Expected format:
 *   Authorization: L402 <base64-macaroon>:<hex-preimage>
 *
 * Also accepts legacy LSAT scheme for backwards compatibility.
 */

import type { ParsedL402Authorization } from "../types.js";
import { L402_SCHEME, LSAT_SCHEME, MAX_AUTH_HEADER_SIZE } from "./l402.js";

/** Error indicating the authorization header is malformed. */
export class MalformedAuthHeaderError extends Error {
  constructor(reason: string) {
    super(`Malformed L402 authorization header: ${reason}`);
    this.name = "MalformedAuthHeaderError";
  }
}

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;
const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/;

/**
 * Parse an L402 Authorization header value.
 *
 * @param headerValue The raw Authorization header string.
 * @returns The parsed L402 authorization, or an error.
 */
export function parseL402Authorization(
  headerValue: string,
): { ok: true; value: ParsedL402Authorization } | { ok: false; reason: string } {
  if (headerValue.length > MAX_AUTH_HEADER_SIZE) {
    return { ok: false, reason: "header too large" };
  }

  const trimmed = headerValue.trim();

  // Split on first space to get scheme.
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { ok: false, reason: "missing scheme" };
  }

  const scheme = trimmed.slice(0, spaceIdx).toUpperCase();
  if (scheme !== L402_SCHEME && scheme !== LSAT_SCHEME) {
    return { ok: false, reason: `unsupported scheme: ${scheme}` };
  }

  const credentials = trimmed.slice(spaceIdx + 1).trim();
  if (!credentials) {
    return { ok: false, reason: "missing credentials" };
  }

  // Split on colon to separate macaroon(s) and preimage.
  const colonIdx = credentials.lastIndexOf(":");
  if (colonIdx === -1) {
    return { ok: false, reason: "missing colon separator between macaroon and preimage" };
  }

  const macaroonPart = credentials.slice(0, colonIdx);
  const preimageHex = credentials.slice(colonIdx + 1);

  // Validate preimage: must be exactly 64 hex characters (32 bytes).
  if (!HEX_REGEX.test(preimageHex)) {
    return { ok: false, reason: "preimage must be 64 hex characters" };
  }

  // Validate macaroon: must be valid base64.
  if (!macaroonPart || !BASE64_REGEX.test(macaroonPart)) {
    return { ok: false, reason: "invalid base64 macaroon" };
  }

  // V1: single macaroon. Support multiple later by splitting on comma.
  const macaroonsB64 = [macaroonPart];

  return {
    ok: true,
    value: {
      scheme: "L402",
      macaroonsB64,
      preimageHex,
    },
  };
}
