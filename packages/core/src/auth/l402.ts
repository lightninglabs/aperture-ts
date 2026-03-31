/**
 * L402 type exports and constants.
 */

export { type ParsedL402Authorization, type VerifiedL402Context } from "../types.js";

/** The L402 authorization scheme identifier. */
export const L402_SCHEME = "L402" as const;

/** Legacy LSAT scheme identifier (backwards compatibility). */
export const LSAT_SCHEME = "LSAT" as const;

/** Maximum allowed authorization header size in bytes. */
export const MAX_AUTH_HEADER_SIZE = 4096;
