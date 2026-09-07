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

import { paymentHashFromPreimage } from "@lightninglabs/aperture-core/util";
import {
  INTENT_CHARGE,
  INTENT_SESSION,
  METHOD_LIGHTNING,
  PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE,
  PROBLEM_LIGHTNING_SESSION_CLOSED,
  PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
  PROBLEM_VERIFICATION_FAILED,
  RECEIPT_STATUS_SUCCESS,
  computeChallengeId,
  decodeRequestObject,
  encodeReceipt,
  encodeRequestObject,
  formatChallengeHeader,
  parseCredential,
  type ChallengeParams,
  type ChargeRequest,
  type Receipt,
  type SessionPayload,
  type SessionReceipt,
  type SessionRequest,
} from "@lightninglabs/aperture-core/mpp";

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

/** What a `SessionSeller` holds against one session id. */
interface SellerSession {
  balance: number;
  spent: number;
  open: boolean;
}

/**
 * A stateful seller enforcing the reference implementation's session state
 * machine, so a test cannot pass by speaking a dialect the real server
 * refuses.
 *
 * The rules mirror aperture's session authenticator: a session exists only
 * once an `open` credential carrying the deposit preimage and a return
 * invoice has been accepted, a replayed `open` is refused, a `bearer` must
 * name an existing session and prove the deposit preimage before its price
 * is deducted, a `topUp` must prove the top-up preimage against the very
 * challenge it echoes and credits at most once, and a `close` must prove
 * the deposit preimage to collect the refund.
 */
export class SessionSeller {
  private readonly sessions = new Map<string, SellerSession>();

  /** Payment hashes that have funded something, mirroring the credit claim. */
  private readonly credited = new Map<string, string>();

  /** Every refusal, with its reason, for tests that assert on why. */
  readonly refusals: string[] = [];

  constructor(
    private readonly options: {
      /** The session offer a 402 carries. */
      offer: ChallengeParams;

      /** The offer an insufficient-balance 402 carries, when it differs. */
      topUpOffer?: ChallengeParams;
    },
  ) {}

  /** The balance a session still holds, for assertions. */
  remaining(sessionId: string): number | null {
    const session = this.sessions.get(sessionId);
    return session === null || session === undefined
      ? null
      : session.balance - session.spent;
  }

  /** Answer one request the way the reference authenticator would. */
  async handle(authorization: string | null): Promise<Response> {
    if (authorization === null || authorization === "") {
      return challengeResponse([this.options.offer]);
    }

    let payload: SessionPayload;
    let request: SessionRequest;
    try {
      const credential = parseCredential<SessionPayload>(authorization);
      payload = credential.payload;
      request = decodeRequestObject<SessionRequest>(
        credential.challenge.request,
      );
    } catch (err) {
      return this.refuse(`unparseable credential: ${String(err)}`, {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    switch (payload.action) {
      case "open":
        return this.handleOpen(payload, request);
      case "bearer":
        return this.handleBearer(payload, request);
      case "topUp":
        return this.handleTopUp(payload, request);
      case "close":
        return this.handleClose(payload);
      default:
        return this.refuse(`unknown action ${String(payload.action)}`, {
          type: PROBLEM_VERIFICATION_FAILED,
        });
    }
  }

  private async handleOpen(
    payload: SessionPayload,
    request: SessionRequest,
  ): Promise<Response> {
    if (!payload.preimage) {
      return this.refuse("open without preimage", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }
    if (!payload.returnInvoice) {
      return this.refuse("open without return invoice", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const sessionId = await paymentHashFromPreimage(payload.preimage);
    if (sessionId !== request.paymentHash.toLowerCase()) {
      return this.refuse("open preimage does not answer the challenge", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }
    if (this.credited.has(sessionId)) {
      return this.refuse("replayed open", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    this.credited.set(sessionId, sessionId);
    this.sessions.set(sessionId, {
      balance: Number(request.depositAmount ?? "0"),
      spent: 0,
      open: true,
    });
    return new Response("ok", { status: 200 });
  }

  private async handleBearer(
    payload: SessionPayload,
    request: SessionRequest,
  ): Promise<Response> {
    if (!payload.sessionId || !payload.preimage) {
      return this.refuse("bearer without sessionId or preimage", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const session = this.sessions.get(payload.sessionId);
    if (session === undefined) {
      return this.refuse("bearer for a session never opened", {
        type: PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
      });
    }
    if (!session.open) {
      return this.refuse("bearer for a closed session", {
        type: PROBLEM_LIGHTNING_SESSION_CLOSED,
      });
    }
    if ((await paymentHashFromPreimage(payload.preimage)) !== payload.sessionId) {
      return this.refuse("bearer preimage does not prove the deposit", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const price = Number(request.amount || "0");
    if (session.spent + price > session.balance) {
      return this.refuse(
        "insufficient balance",
        { type: PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE },
        this.options.topUpOffer,
      );
    }

    session.spent += price;
    return new Response("ok", { status: 200 });
  }

  private async handleTopUp(
    payload: SessionPayload,
    request: SessionRequest,
  ): Promise<Response> {
    if (!payload.sessionId || !payload.topUpPreimage) {
      return this.refuse("topUp without sessionId or topUpPreimage", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const session = this.sessions.get(payload.sessionId);
    if (session === undefined || !session.open) {
      return this.refuse("topUp for a session not open", {
        type: PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
      });
    }

    const topUpHash = await paymentHashFromPreimage(payload.topUpPreimage);
    if (topUpHash !== request.paymentHash.toLowerCase()) {
      return this.refuse("topUp preimage does not answer the challenge", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const creditedTo = this.credited.get(topUpHash);
    if (creditedTo === payload.sessionId) {
      // A replay of a credit already applied proceeds without crediting
      // again, matching the reference: no satoshis move either way.
      return new Response("ok", { status: 200 });
    }
    if (creditedTo !== undefined) {
      return this.refuse("topUp payment already funded another session", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    this.credited.set(topUpHash, payload.sessionId);
    session.balance += Number(request.depositAmount ?? "0");
    return new Response("ok", { status: 200 });
  }

  private async handleClose(payload: SessionPayload): Promise<Response> {
    if (!payload.sessionId || !payload.preimage) {
      return this.refuse("close without sessionId or preimage", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    const session = this.sessions.get(payload.sessionId);
    if (session === undefined) {
      return this.refuse("close for a session never opened", {
        type: PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
      });
    }
    if (!session.open) {
      return this.refuse("close for a session already closed", {
        type: PROBLEM_LIGHTNING_SESSION_CLOSED,
      });
    }
    if ((await paymentHashFromPreimage(payload.preimage)) !== payload.sessionId) {
      return this.refuse("close preimage does not prove the deposit", {
        type: PROBLEM_VERIFICATION_FAILED,
      });
    }

    session.open = false;
    const refund = session.balance - session.spent;
    return receiptResponse({
      reference: payload.sessionId,
      ...(refund > 0
        ? { refundSats: refund, refundStatus: "succeeded" as const }
        : { refundStatus: "skipped" as const }),
    });
  }

  private refuse(
    reason: string,
    problem: { type: string },
    offer?: ChallengeParams,
  ): Response {
    this.refusals.push(reason);
    return challengeResponse(
      [offer ?? this.options.offer],
      problem,
    );
  }
}
