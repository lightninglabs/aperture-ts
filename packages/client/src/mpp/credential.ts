/**
 * Building the `Authorization: Payment` credential a client sends back.
 *
 * The challenge half of a credential is an echo, not a construction. The
 * server bound those parameters with an HMAC it is about to recompute, so
 * every field comes back exactly as it arrived, and any field that was
 * absent stays absent.
 */

import {
  formatAuthorizationHeader,
  type ChallengeEcho,
  type ChallengeParams,
  type ChargePayload,
  type Credential,
  type SessionPayload,
} from "@aperture/core/mpp";

/**
 * Convert parsed challenge parameters into the echo that goes back in a
 * credential. `id` rides along unchanged; it is the server's own HMAC over
 * the rest.
 */
export function toChallengeEcho(params: ChallengeParams): ChallengeEcho {
  const echo: ChallengeEcho = {
    id: params.id,
    realm: params.realm,
    method: params.method,
    intent: params.intent,
    request: params.request,
  };

  if (params.expires !== undefined) echo.expires = params.expires;
  if (params.description !== undefined) echo.description = params.description;
  if (params.opaque !== undefined) echo.opaque = params.opaque;
  if (params.digest !== undefined) echo.digest = params.digest;

  return echo;
}

/**
 * Options every credential builder accepts.
 *
 * `source` is the W3C DID payer identifier the scheme allows. This client
 * never populates it. It is the first field in the stack that would let a
 * seller correlate one buyer's payments with each other, and switching that
 * on is a decision for whoever ships the wallet, not a default the
 * transport picks. The parameter exists so that decision has somewhere to
 * land, not because anything here fills it in.
 */
export interface CredentialOptions {
  source?: string;
}

/** Build the credential for a charge: the preimage, and nothing else. */
export function buildChargeCredential(
  params: ChallengeParams,
  preimageHex: string,
  options: CredentialOptions = {},
): Credential<ChargePayload> {
  return withSource(
    { challenge: toChallengeEcho(params), payload: { preimage: preimageHex } },
    options,
  );
}

/** Build the credential for any of the four session actions. */
export function buildSessionCredential(
  params: ChallengeParams,
  payload: SessionPayload,
  options: CredentialOptions = {},
): Credential<SessionPayload> {
  return withSource({ challenge: toChallengeEcho(params), payload }, options);
}

/** Build the credential for a session echo the client already holds. */
export function buildSessionCredentialFromEcho(
  echo: ChallengeEcho,
  payload: SessionPayload,
  options: CredentialOptions = {},
): Credential<SessionPayload> {
  return withSource({ challenge: echo, payload }, options);
}

/** Render a credential as the complete `Authorization` header value. */
export function toAuthorizationHeader(credential: Credential): string {
  return formatAuthorizationHeader(credential);
}

function withSource<T>(
  credential: Credential<T>,
  options: CredentialOptions,
): Credential<T> {
  if (options.source === undefined) return credential;
  return { ...credential, source: options.source };
}
