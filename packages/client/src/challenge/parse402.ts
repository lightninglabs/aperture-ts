/**
 * Parse a 402 Payment Required response into a structured L402 challenge.
 */

export interface L402Challenge {
  challengeId: string;
  routeId: string;
  amountSat: number;
  invoice: string;
  macaroon: string;
  expiresAt: string;
}

/**
 * Parse a 402 response from an Aperture-gated endpoint.
 * Extracts challenge info from headers and JSON body.
 */
export async function parse402Response(
  response: Response,
): Promise<L402Challenge> {
  if (response.status !== 402) {
    throw new Error(`Expected 402 response, got ${response.status}`);
  }

  // Try JSON body first (richest source).
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json()) as Record<string, unknown>;
    return {
      challengeId: String(body.challenge_id ?? ""),
      routeId: String(body.route_id ?? ""),
      amountSat: Number(body.amount_sat ?? 0),
      invoice: String(body.invoice ?? ""),
      macaroon: String(body.macaroon ?? ""),
      expiresAt: String(body.expires_at ?? ""),
    };
  }

  // Fall back to headers.
  const wwwAuth = response.headers.get("WWW-Authenticate") ?? "";
  const macaroon = extractQuoted(wwwAuth, "macaroon");
  const invoice = extractQuoted(wwwAuth, "invoice");

  return {
    challengeId: response.headers.get("X-Aperture-Challenge-Id") ?? "",
    routeId: response.headers.get("X-Aperture-Route-Id") ?? "",
    amountSat: parseInt(
      response.headers.get("X-Aperture-Price-Sat") ?? "0",
      10,
    ),
    invoice,
    macaroon,
    expiresAt: "",
  };
}

function extractQuoted(header: string, key: string): string {
  const regex = new RegExp(`${key}="([^"]*)"`, "i");
  const match = header.match(regex);
  return match?.[1] ?? "";
}
