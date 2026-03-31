/**
 * Build HTTP 402 Payment Required challenge responses.
 * Implements the challenge format from design doc section 13.
 */

export interface L402ChallengeParams {
  challengeId: string;
  routeId: string;
  amountSat: number;
  invoice: string;
  macaroonB64: string;
  expiresAt: string;
}

/**
 * Build a standards-compliant HTTP 402 challenge response.
 */
export function buildHttp402Challenge(params: L402ChallengeParams): Response {
  const {
    challengeId,
    routeId,
    amountSat,
    invoice,
    macaroonB64,
    expiresAt,
  } = params;

  const body = JSON.stringify({
    error: "payment_required",
    scheme: "L402",
    challenge_id: challengeId,
    route_id: routeId,
    amount_sat: amountSat,
    invoice,
    macaroon: macaroonB64,
    expires_at: expiresAt,
  });

  return new Response(body, {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `L402 macaroon="${macaroonB64}", invoice="${invoice}"`,
      "X-Aperture-Challenge-Id": challengeId,
      "X-Aperture-Price-Sat": amountSat.toString(),
      "X-Aperture-Route-Id": routeId,
    },
  });
}
