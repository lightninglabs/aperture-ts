/**
 * Fixtures for the Payment-scheme tests: a stub seller that issues real
 * challenges, and a payer whose preimages actually hash to the payment
 * hashes those challenges name.
 *
 * The hashing matters. The client's one trust-free check is that
 * sha256(preimage) equals the payment hash the challenge quoted, so a
 * fixture that hands back an arbitrary preimage would test the code with
 * that check disabled.
 *
 * Test-only. Not exported from the package index.
 */

import { paymentHashFromPreimage } from "@aperture/core/util";
import {
  INTENT_CHARGE,
  INTENT_SESSION,
  METHOD_LIGHTNING,
  RECEIPT_STATUS_SUCCESS,
  computeChallengeId,
  encodeReceipt,
  encodeRequestObject,
  formatChallengeHeader,
  type ChallengeParams,
  type ChargeRequest,
  type Receipt,
  type SessionReceipt,
  type SessionRequest,
} from "@aperture/core/mpp";

export const SELLER_SECRET = "fixture-server-secret-key-32-byte";
export const REALM = "api.example.com";

/** Derive a distinct 32-byte preimage from a small label. */
export function preimageFor(label: string): string {
  let hex = "";
  for (let i = 0; i < 32; i++) {
    const code = label.charCodeAt(i % label.length) + i;
    hex += (code % 256).toString(16).padStart(2, "0");
  }
  return hex;
}

/** The payment hash a preimage actually commits to. */
export async function hashFor(label: string): Promise<string> {
  return paymentHashFromPreimage(preimageFor(label));
}

/**
 * Build a BOLT11-shaped invoice string carrying a decodable amount. Only
 * the human-readable part is meaningful; the client decodes no further.
 */
export function invoiceFor(amountSat: number, tag: string): string {
  return `lnbc${amountSat * 10}n1${tag.replace(/[^a-z0-9]/g, "")}`;
}

/** Issue a charge challenge whose id is a real HMAC over its parameters. */
export async function chargeChallenge(options: {
  amountSat: number;
  label: string;
  expires?: string;
  realm?: string;
  description?: string;
}): Promise<ChallengeParams> {
  const request: ChargeRequest = {
    amount: String(options.amountSat),
    currency: "sat",
    methodDetails: {
      invoice: invoiceFor(options.amountSat, options.label),
      paymentHash: await hashFor(options.label),
      network: "regtest",
    },
  };
  if (options.description !== undefined) {
    request.description = options.description;
  }

  return signChallenge({
    realm: options.realm ?? REALM,
    intent: INTENT_CHARGE,
    request: encodeRequestObject(request as never),
    ...(options.expires === undefined ? {} : { expires: options.expires }),
  });
}

/** Issue a session challenge whose deposit invoice matches its hash. */
export async function sessionChallenge(options: {
  depositSat: number;
  pricePerUnitSat: number;
  label: string;
  expires?: string;
  realm?: string;
  withoutDepositInvoice?: boolean;
}): Promise<ChallengeParams> {
  const request: SessionRequest = {
    amount: String(options.pricePerUnitSat),
    currency: "sat",
    unitType: "token",
    paymentHash: await hashFor(options.label),
    depositAmount: String(options.depositSat),
    idleTimeout: "300",
  };
  if (options.withoutDepositInvoice !== true) {
    request.depositInvoice = invoiceFor(options.depositSat, options.label);
  }

  return signChallenge({
    realm: options.realm ?? REALM,
    intent: INTENT_SESSION,
    request: encodeRequestObject(request as never),
    ...(options.expires === undefined ? {} : { expires: options.expires }),
  });
}

async function signChallenge(params: {
  realm: string;
  intent: string;
  request: string;
  expires?: string;
}): Promise<ChallengeParams> {
  const unsigned = {
    realm: params.realm,
    method: METHOD_LIGHTNING,
    intent: params.intent,
    request: params.request,
    ...(params.expires === undefined ? {} : { expires: params.expires }),
  };

  return {
    id: await computeChallengeId(SELLER_SECRET, unsigned),
    ...unsigned,
  };
}

/** Build a 402 offering one or more challenges, with an optional problem. */
export function challengeResponse(
  challenges: ChallengeParams[],
  problem?: { type: string; title?: string; detail?: string },
): Response {
  const headers = new Headers();
  for (const challenge of challenges) {
    headers.append("WWW-Authenticate", formatChallengeHeader(challenge));
  }

  if (problem === undefined) {
    return new Response(null, { status: 402, headers });
  }

  headers.set("Content-Type", "application/problem+json");
  return new Response(
    JSON.stringify({
      type: problem.type,
      title: problem.title ?? "Payment Required",
      status: 402,
      detail: problem.detail,
    }),
    { status: 402, headers },
  );
}

/** Build a 200 carrying a Payment-Receipt header. */
export function receiptResponse(
  receipt: Partial<SessionReceipt> & Pick<Receipt, "reference">,
  body = "ok",
): Response {
  const full: SessionReceipt = {
    status: RECEIPT_STATUS_SUCCESS,
    method: METHOD_LIGHTNING,
    timestamp: "2026-03-10T21:00:00Z",
    ...receipt,
  };

  return new Response(body, {
    status: 200,
    headers: { "Payment-Receipt": encodeReceipt(full) },
  });
}

/**
 * A payer that returns the preimage registered for an invoice, and refuses
 * anything else rather than quietly paying with somebody else's preimage.
 */
export class ScriptedPayer {
  private readonly byInvoice = new Map<string, string>();

  /** Every invoice this payer has been asked to settle, in order. */
  readonly paid: string[] = [];

  /** Register the preimage an invoice settles to. */
  expect(invoice: string, preimageHex: string): this {
    this.byInvoice.set(invoice, preimageHex);
    return this;
  }

  /** Register a label's invoice and preimage together. */
  async expectLabel(amountSat: number, label: string): Promise<this> {
    return this.expect(invoiceFor(amountSat, label), preimageFor(label));
  }

  async payInvoice(input: {
    invoice: string;
    amountSat: number;
    challengeId: string;
  }): Promise<{ preimageHex: string; amountPaidSat: number }> {
    const preimage = this.byInvoice.get(input.invoice);
    if (preimage === undefined) {
      throw new Error(`ScriptedPayer: no preimage for ${input.invoice}`);
    }

    this.paid.push(input.invoice);
    return { preimageHex: preimage, amountPaidSat: input.amountSat };
  }
}
