/**
 * The Payment-scheme half of the buyer loop.
 *
 * The disciplines here are the same ones the L402 path already holds, for
 * the same reasons:
 *
 *  - At most one payment per call. Every path through this module is
 *    checked against a counter that throws if a second payment is ever
 *    reached, because the interesting bugs in a paying client are not the
 *    ones that fail, they are the ones that succeed twice.
 *
 *  - Exactly one retry after that payment. Whatever the retry returns is
 *    what the caller gets, including another 402. A client that pays again
 *    when the paid request is refused has built a loop with a wallet
 *    attached to it.
 *
 *  - The credential is stored before the retry runs. Money has already
 *    moved by then, so a retry that throws must not also lose the thing the
 *    money bought.
 */

import type { BuyerPolicy } from "@aperture/core";
import { paymentHashFromPreimage } from "@aperture/core/util";
import {
  INTENT_CHARGE,
  INTENT_SESSION,
  METHOD_LIGHTNING,
  PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE,
  PROBLEM_LIGHTNING_SESSION_CLOSED,
  PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
  PROBLEM_PAYMENT_INSUFFICIENT,
  type ProblemDetails,
  type SessionReceipt,
} from "@aperture/core/mpp";
import type { InvoicePayer } from "@aperture/core";
import type { CredentialStore } from "../cache/credentialCache.js";
import type { ReceiptStore } from "../cache/receiptCache.js";
import type { SessionRecord } from "../cache/sessionStore.js";
import {
  parseDecimalSat,
  requireBoundedAmount,
  resolveAmountSat,
} from "../challenge/amountSafety.js";
import {
  isChallengeExpired,
  readProblem,
  selectChallenge,
  type ChargeChallenge,
  type PaymentChallenge,
  type SessionChallenge,
} from "./challenge.js";
import { buildChargeCredential, toAuthorizationHeader } from "./credential.js";
import { checkReceipt, readReceipt } from "./receipt.js";
import { SessionManager } from "./sessionManager.js";

/** How a request is re-sent once a credential is in hand. */
export type CredentialedRetry = (authorization: string) => Promise<Response>;

export interface PaymentFlowConfig {
  payer: InvoicePayer;
  sessions: SessionManager;
  credentialCache: CredentialStore;
  receiptStore: ReceiptStore;
  buyerPolicy?: BuyerPolicy;

  /** Intent preference, most wanted first. */
  intents: readonly string[];

  /** Reported when a receipt disagrees with what the client paid for. */
  onReceiptMismatch?: (mismatch: {
    receipt: SessionReceipt;
    reasons: string[];
  }) => void;

  now?: () => number;
}

export interface PaymentFlowInput {
  /** The 402 that started this, headers already parsed into challenges. */
  challenges: PaymentChallenge[];
  response: Response;

  url: string;
  origin: string;
  credentialKey: string;

  /** The session the first attempt used, when it used one. */
  attemptedSession: SessionRecord | null;

  /** Re-send the original request with this Authorization header. */
  retry: CredentialedRetry;

  /** Throws if the caller has already been aborted. */
  assertNotAborted: () => void;
}

/**
 * Satisfy a Payment challenge, or hand the 402 back untouched.
 *
 * Returning the original 402 is a real outcome, not a failure path. When
 * the server offers nothing this client can act on, or when what went wrong
 * is ambiguous enough that the recovery would be a guess with money behind
 * it, surfacing the server's own answer beats inventing one.
 */
export async function runPaymentFlow(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
): Promise<Response> {
  const budget = new PaymentBudget();
  const problem = await readProblem(input.response);

  if (input.attemptedSession === null) {
    return runFreshFlow(config, input, budget, config.intents);
  }

  const recovery = await recoverSession(config, input, problem, budget);
  if (recovery.kind === "handled") return recovery.response;

  return runFreshFlow(config, input, budget, recovery.intents);
}

/** What is left to try after a session recovery attempt. */
type SessionRecovery =
  | { kind: "handled"; response: Response }
  | { kind: "fallthrough"; intents: readonly string[] };

/**
 * Recover a session whose bearer credential the server just refused.
 *
 * The server's problem type is what distinguishes the two recoveries, and
 * they are not interchangeable. Topping up a session the server has already
 * discarded burns the top-up; opening a fresh session while the old one is
 * merely empty strands the first deposit until something closes it.
 *
 * When neither applies, this falls through with the session intent off the
 * table. Whatever went wrong, buying a second deposit is not the answer to
 * it, but a charge offer sitting alongside is still worth taking.
 */
async function recoverSession(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
  problem: ProblemDetails | null,
  budget: PaymentBudget,
): Promise<SessionRecovery> {
  const session = input.attemptedSession as SessionRecord;
  const offer = selectChallenge(input.challenges, [INTENT_SESSION]) as
    | SessionChallenge
    | null;
  const fundable =
    offer !== null && offer.request.depositInvoice !== undefined;

  const gone =
    problem?.type === PROBLEM_LIGHTNING_SESSION_NOT_FOUND ||
    problem?.type === PROBLEM_LIGHTNING_SESSION_CLOSED;

  if (gone) {
    // The server holds no balance under this id, so there is nothing left
    // to close and nothing to refund. Dropping the record is the only way
    // to stop producing credentials it will keep refusing, and it is what
    // makes opening a replacement safe.
    await config.sessions.forget(session.key);
    return { kind: "fallthrough", intents: config.intents };
  }

  const insufficient =
    problem?.type === PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE ||
    problem?.type === PROBLEM_PAYMENT_INSUFFICIENT ||
    (problem === null && config.sessions.remainingSat(session) <= 0);

  if (!insufficient || !fundable) {
    return { kind: "fallthrough", intents: [INTENT_CHARGE] };
  }

  // The server is the one debiting the balance, so its word replaces the
  // local estimate rather than being averaged with it.
  await config.sessions.reconcile(session.key, { remainingSat: 0 });

  const challenge = offer as SessionChallenge;
  assertUsable(challenge, config.now);
  input.assertNotAborted();

  budget.spend();
  const topped = await config.sessions.topUp({
    key: session.key,
    url: input.url,
    challenge,
  });

  return {
    kind: "handled",
    response: await retryWithSession(config, input, topped),
  };
}

/**
 * Take one of the offers on the table, or hand the 402 back untouched.
 *
 * Returning the original 402 is a real outcome, not a failure path. When
 * the server offers nothing this client can act on, surfacing the server's
 * own answer beats inventing one.
 */
async function runFreshFlow(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
  budget: PaymentBudget,
  intents: readonly string[],
): Promise<Response> {
  const usable = (challenge: PaymentChallenge): boolean =>
    challenge.intent === INTENT_CHARGE ||
    (config.sessions.canOpenSessions() &&
      (challenge as SessionChallenge).request.depositInvoice !== undefined);

  const challenge = selectChallenge(input.challenges, intents, usable);
  if (challenge === null) return input.response;

  if (challenge.intent === INTENT_SESSION) {
    return openSessionAndRetry(config, input, challenge, budget);
  }

  return payChargeAndRetry(config, input, challenge, budget);
}

async function openSessionAndRetry(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
  challenge: SessionChallenge,
  budget: PaymentBudget,
): Promise<Response> {
  assertUsable(challenge, config.now);
  input.assertNotAborted();

  const key = SessionManager.key(input.origin, challenge.params.realm);

  budget.spend();
  const record = await config.sessions.open({
    key,
    origin: input.origin,
    url: input.url,
    challenge,
  });

  return retryWithSession(config, input, record);
}

/**
 * Send the paid request under a session, then charge the local estimate.
 *
 * The estimate is decremented after the response comes back rather than
 * before it goes out, so a request the server never priced does not show up
 * as spend. It is only ever an estimate: the server settles metered work
 * against its own numbers afterwards.
 */
async function retryWithSession(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
  record: SessionRecord,
): Promise<Response> {
  const credential = config.sessions.bearerCredential(record);
  const response = await input.retry(toAuthorizationHeader(credential));

  await noteReceipt(config, response, {
    method: METHOD_LIGHTNING,
    challengeId: record.challenge.id,
    reference: record.sessionId,
  });

  if (response.ok && record.pricePerUnitSat !== null) {
    await config.sessions.recordSpend(record.key, record.pricePerUnitSat);
  }

  return response;
}

async function payChargeAndRetry(
  config: PaymentFlowConfig,
  input: PaymentFlowInput,
  challenge: ChargeChallenge,
  budget: PaymentBudget,
): Promise<Response> {
  assertUsable(challenge, config.now);

  const invoice = challenge.request.methodDetails.invoice;
  const amountSat = requireBoundedAmount(
    resolveAmountSat(parseDecimalSat(challenge.request.amount) ?? 0, invoice),
    "mpp charge",
  );

  if (config.buyerPolicy !== undefined) {
    await config.buyerPolicy.assertAllowed({
      url: input.url,
      host: new URL(input.url).hostname,
      amountSat,
      routeId: challenge.params.realm || undefined,
    });
  }

  // Re-check the abort signal: the caller may have given up while the
  // policy was resolving, and the wallet must not spend on a request that
  // has already been abandoned.
  input.assertNotAborted();

  budget.spend();
  const payment = await config.payer.payInvoice({
    invoice,
    amountSat,
    challengeId: challenge.params.id,
  });

  // Derive the payment hash rather than trusting the challenge's copy of
  // it, and complain when the two disagree: a challenge whose stated hash
  // the preimage does not produce was describing a different invoice than
  // the one that got paid.
  let paymentHash = "";
  try {
    paymentHash = await paymentHashFromPreimage(payment.preimageHex);

    const quoted = challenge.request.methodDetails.paymentHash;
    if (quoted !== undefined && quoted.toLowerCase() !== paymentHash) {
      console.warn(
        `mpp: charge challenge named payment hash ${quoted}, but the paid ` +
          `preimage hashes to ${paymentHash}`,
      );
    }
  } catch (err) {
    console.warn("mpp: unhashable payment preimage:", err);
  }

  const credential = buildChargeCredential(
    challenge.params,
    payment.preimageHex,
  );
  const authorization = toAuthorizationHeader(credential);

  // Both writes happen before the retry, and neither may abort the request.
  // The credential is in hand, so serving the response the caller paid for
  // beats failing on a durable-store error: a failed write costs at worst a
  // re-purchase or a gap in the ledger, while failing here wastes the whole
  // payment.
  const writes = await Promise.allSettled([
    (async () =>
      config.receiptStore.store({
        paymentHash,
        amountSat,
        paidSat: payment.amountPaidSat,
        invoice,
        preimageHex: payment.preimageHex,
        url: input.url,
        timestamp: new Date(config.now?.() ?? Date.now()).toISOString(),
      }))(),
    (async () =>
      config.credentialCache.put(input.credentialKey, {
        authorization,
        challengeId: challenge.params.id,
        ...(challenge.params.expires === undefined
          ? {}
          : { expiresAt: challenge.params.expires }),
      }))(),
  ]);
  for (const write of writes) {
    if (write.status === "rejected") {
      console.warn("mpp: post-payment store failed:", write.reason);
    }
  }

  const response = await input.retry(authorization);

  await noteReceipt(config, response, {
    method: METHOD_LIGHTNING,
    challengeId: challenge.params.id,
    reference: paymentHash || undefined,
  });

  return response;
}

/**
 * Read the receipt off a paid response and report any disagreement.
 *
 * A mismatch does not fail the request. By this point the money has moved
 * and the response is in hand, so failing would cost the caller what they
 * paid for without recovering any of it. What it must not do is vanish: a
 * receipt naming a different payment than the one just made is the first
 * visible sign that buyer and seller disagree about what happened.
 */
async function noteReceipt(
  config: PaymentFlowConfig,
  response: Response,
  expectation: {
    method: string;
    challengeId?: string;
    reference?: string;
  },
): Promise<void> {
  const receipt = readReceipt<SessionReceipt>(response);
  if (receipt === null) return;

  const reasons = checkReceipt(receipt, expectation);
  if (reasons.length === 0) return;

  config.onReceiptMismatch?.({ receipt, reasons });
  console.warn(`mpp: receipt mismatch: ${reasons.join("; ")}`);
}

/** Refuse to pay against a challenge the server would refuse anyway. */
function assertUsable(
  challenge: PaymentChallenge,
  now: (() => number) | undefined,
): void {
  if (isChallengeExpired(challenge.params, now?.() ?? Date.now())) {
    throw new Error(
      `mpp: challenge ${challenge.params.id} expired at ` +
        `${challenge.params.expires}; refusing to pay against it`,
    );
  }
}

/**
 * The one-payment-per-call guard.
 *
 * This is a tripwire rather than control flow. Every path above is written
 * so that at most one payment is reachable, and if that ever stops being
 * true the failure should be an exception in a test rather than a second
 * invoice on a live wallet.
 */
class PaymentBudget {
  private spent = 0;

  spend(): void {
    this.spent += 1;
    if (this.spent > 1) {
      throw new Error(
        "mpp: refusing a second payment within one request; this is a bug " +
          "in the buyer loop",
      );
    }
  }
}
