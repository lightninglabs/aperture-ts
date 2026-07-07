/**
 * Parse a 402 Payment Required response into a structured L402 challenge.
 */

import { bolt11AmountSat } from "./bolt11Amount.js";

export interface L402Challenge {
  challengeId: string;
  routeId: string;
  /**
   * The satoshi amount the buyer policy must assert on. A number is a known
   * bound on the outflow; null means an invoice was present but its amount
   * could not be decoded, so the outflow is unbounded and the caller must
   * refuse to pay.
   */
  amountSat: number | null;
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
    const invoice = String(body.invoice ?? "");
    return {
      challengeId: String(body.challenge_id ?? ""),
      routeId: String(body.route_id ?? ""),
      amountSat: resolveAmountSat(Number(body.amount_sat ?? 0), invoice),
      invoice,
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
    amountSat: resolveAmountSat(
      parseInt(response.headers.get("X-Aperture-Price-Sat") ?? "0", 10),
      invoice,
    ),
    invoice,
    macaroon,
    expiresAt: "",
  };
}

/**
 * Resolve the satoshi amount the buyer policy must assert on. The wallet
 * pays whatever the invoice encodes, so the policy must bound at least that
 * amount: when both a seller-stated price and an invoice-encoded amount are
 * present, assert on the larger of the two. A materially larger stated
 * price over the invoice is suspicious, but max() is the safe minimal
 * choice — it never asserts on less than the wallet will actually spend.
 *
 * When the invoice string is present but its amount cannot be decoded, the
 * outflow is unbounded, so return null rather than trusting the stated
 * price or fabricating a 0. The Go aperture proxy sends only the
 * WWW-Authenticate header with no price field, so the invoice is usually
 * the sole source of the amount.
 */
function resolveAmountSat(stated: number, invoice: string): number | null {
  const decoded = invoice === "" ? undefined : bolt11AmountSat(invoice);

  // An invoice was present but its amount could not be decoded: the outflow
  // is unbounded, so refuse to bound it with the stated price.
  if (decoded === null) return null;

  const statedSat =
    Number.isFinite(stated) && stated > 0 ? stated : undefined;

  if (decoded !== undefined && statedSat !== undefined) {
    return Math.max(statedSat, decoded);
  }
  if (decoded !== undefined) return decoded;
  if (statedSat !== undefined) return statedSat;

  // Neither an invoice amount nor a stated price is available.
  return 0;
}

function extractQuoted(header: string, key: string): string {
  const regex = new RegExp(`${key}="([^"]*)"`, "i");
  const match = header.match(regex);
  return match?.[1] ?? "";
}
