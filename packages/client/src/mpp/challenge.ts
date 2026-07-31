/**
 * Reading a 402 that offers the `Payment` authentication scheme.
 *
 * A single 402 may carry several offers: a charge for callers that want one
 * resource, a session for callers that want many, and possibly an L402
 * challenge alongside for older clients. This module turns that into a
 * typed list, discards the offers this client cannot satisfy, and picks one.
 */

import {
  INTENT_CHARGE,
  INTENT_SESSION,
  METHOD_LIGHTNING,
  decodeRequestObject,
  parsePaymentChallenges,
  type ChallengeParams,
  type ChargeRequest,
  type ProblemDetails,
  type SessionRequest,
} from "@aperture/core/mpp";

/** A charge offer: pay one invoice, get one response. */
export interface ChargeChallenge {
  intent: typeof INTENT_CHARGE;
  params: ChallengeParams;
  request: ChargeRequest;
}

/** A session offer: deposit once, spend the balance down over many calls. */
export interface SessionChallenge {
  intent: typeof INTENT_SESSION;
  params: ChallengeParams;
  request: SessionRequest;
}

export type PaymentChallenge = ChargeChallenge | SessionChallenge;

/** Everything a 402 told us, once its headers and body have been read. */
export interface PaymentChallengeSet {
  challenges: PaymentChallenge[];

  /**
   * The RFC 9457 problem document from the response body, when there was
   * one. Its `type` is how a server distinguishes "your session ran out"
   * from "your session does not exist", which lead to different recoveries.
   */
  problem: ProblemDetails | null;
}

/**
 * Read every usable Payment challenge off a response's headers.
 *
 * Offers under another method, or whose intent this client does not
 * implement, or whose request object will not decode, are dropped rather
 * than thrown on: a server is entitled to offer things this client has
 * never heard of, and one bad offer must not cost the client a good one
 * sitting next to it.
 *
 * This deliberately does not touch the body. A 402 body can be read only
 * once, and the caller has to know which protocol it is speaking before
 * deciding who gets to read it.
 */
export function paymentChallengesFromHeaders(
  response: Response,
): PaymentChallenge[] {
  const header = response.headers.get("WWW-Authenticate") ?? "";
  const challenges: PaymentChallenge[] = [];

  for (const params of parsePaymentChallenges(header)) {
    const challenge = toTypedChallenge(params);
    if (challenge !== null) challenges.push(challenge);
  }

  return challenges;
}

/**
 * Read both halves of a 402: the challenges from its headers and the
 * problem document from its body. The body is consumed, so this is for
 * callers that have already committed to the Payment scheme.
 */
export async function readPaymentChallenges(
  response: Response,
): Promise<PaymentChallengeSet> {
  return {
    challenges: paymentChallengesFromHeaders(response),
    problem: await readProblem(response),
  };
}

/**
 * Decode one challenge's request object into its intent-specific shape,
 * returning null when this client cannot act on it.
 */
export function toTypedChallenge(
  params: ChallengeParams,
): PaymentChallenge | null {
  if (params.method !== METHOD_LIGHTNING) return null;

  try {
    if (params.intent === INTENT_CHARGE) {
      const request = decodeRequestObject<ChargeRequest>(params.request);
      if (typeof request?.methodDetails?.invoice !== "string") return null;
      return { intent: INTENT_CHARGE, params, request };
    }

    if (params.intent === INTENT_SESSION) {
      const request = decodeRequestObject<SessionRequest>(params.request);
      if (typeof request?.paymentHash !== "string") return null;
      return { intent: INTENT_SESSION, params, request };
    }
  } catch {
    // A request object that will not decode is an offer this client cannot
    // act on, which is the same situation as an intent it does not know.
    return null;
  }

  return null;
}

/**
 * Pick the challenge to satisfy, in the caller's order of preference.
 *
 * `usable` lets the caller veto an offer it cannot safely take, which is
 * how a session offer gets skipped when there is no way to mint the return
 * invoice that carries the refund home.
 */
export function selectChallenge(
  challenges: PaymentChallenge[],
  preference: readonly string[],
  usable: (challenge: PaymentChallenge) => boolean = () => true,
): PaymentChallenge | null {
  for (const intent of preference) {
    const match = challenges.find((c) => c.intent === intent && usable(c));
    if (match !== undefined) return match;
  }

  return null;
}

/**
 * Report whether a challenge's expiry has passed.
 *
 * An unparseable `expires` counts as expired. The alternative is an
 * immortal challenge built from garbage, and paying against a challenge the
 * server will refuse costs real money for nothing.
 */
export function isChallengeExpired(
  params: ChallengeParams,
  now: number = Date.now(),
): boolean {
  if (!params.expires) return false;

  const expiresMs = Date.parse(params.expires);
  return Number.isNaN(expiresMs) || now > expiresMs;
}

/**
 * Parse an RFC 9457 problem document off a response, returning null when
 * there is not one. Never throws: the problem document is a hint about how
 * to recover, and a malformed hint should not become the failure.
 */
export async function readProblem(
  response: Response,
): Promise<ProblemDetails | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.includes("application/problem+json") &&
    !contentType.includes("application/json")
  ) {
    return null;
  }

  try {
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) return null;

    const problem = body as Partial<ProblemDetails>;
    if (typeof problem.type !== "string") return null;

    return problem as ProblemDetails;
  } catch {
    return null;
  }
}
