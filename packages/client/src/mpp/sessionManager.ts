/**
 * The session state machine.
 *
 * A session is a prepaid balance: pay a deposit once, then authenticate the
 * next several hundred requests with a bearer credential that costs nothing
 * at the wallet, top up when the balance runs low, and close to get the
 * unspent remainder back. That shape moves the money-safety questions off
 * the per-request path and onto three moments, and this module owns all
 * three.
 *
 * Two properties matter more than anything else here:
 *
 *  - One deposit per session. Two concurrent requests that both discover
 *    they need a session must produce one payment, not two, so opens and
 *    top-ups coalesce on the session key rather than merely serializing.
 *
 *  - The session id is derived, not accepted. It is the payment hash of the
 *    deposit invoice, and the client computes it from the preimage it holds
 *    rather than reading it out of the challenge. A challenge that names a
 *    payment hash the preimage does not produce was pointing the deposit
 *    somewhere else, and no session gets built on top of that.
 */

import type { BuyerPolicy, InvoicePayer } from "@aperture/core";
import { paymentHashFromPreimage } from "@aperture/core/util";
import {
  METHOD_LIGHTNING,
  type Credential,
  type NeedTopUpEvent,
  type SessionPayload,
  type SessionReceipt,
} from "@aperture/core/mpp";
import {
  SessionCache,
  type SessionRecord,
  type SessionStore,
} from "../cache/sessionStore.js";
import type { ReceiptStore } from "../cache/receiptCache.js";
import {
  parseDecimalSat,
  requireBoundedAmount,
  resolveAmountSat,
} from "../challenge/amountSafety.js";
import type { SessionChallenge } from "./challenge.js";
import {
  buildSessionCredentialFromEcho,
  toAuthorizationHeader,
  toChallengeEcho,
} from "./credential.js";
import { checkReceipt, readReceipt, readRefund } from "./receipt.js";

/**
 * A wallet's ability to mint an amountless invoice for the refund.
 *
 * The session draft has the client hand the server an invoice with no
 * amount encoded, which the server pays with whatever is left when the
 * session closes. Without one, every unspent satoshi in the deposit stays
 * with the seller, so this is a separate capability from paying, and a
 * client that lacks it declines session offers rather than opening a
 * session it cannot get its money out of.
 */
export interface ReturnInvoiceMinter {
  mintAmountlessInvoice(input: {
    origin: string;
    realm: string;
    memo?: string;
  }): Promise<{ invoice: string }>;
}

export interface SessionManagerConfig {
  payer: InvoicePayer;

  /**
   * Where open sessions live. Defaults to a process-local cache, which
   * loses every open deposit on restart; inject a durable store to keep the
   * refunds reachable.
   */
  store?: SessionStore;

  /** Wallet capability for minting the refund invoice. */
  minter?: ReturnInvoiceMinter;

  /** Audit sink for deposits and top-ups. */
  receiptStore?: ReceiptStore;

  /** Asserted before every deposit and top-up, never on a bearer request. */
  buyerPolicy?: BuyerPolicy;

  /**
   * Open a session even when there is no way to mint a return invoice,
   * forfeiting the unspent balance at close. Off by default.
   */
  allowSessionWithoutRefund?: boolean;

  /**
   * How many units of service the balance estimate must still cover before
   * the client will send another bearer request. Below this it tops up
   * first, rather than spending a round trip on a request the server is
   * about to refuse. Set to 0 to top up only when the server says so.
   */
  minUnitsRemaining?: number;

  /** Reported when a receipt disagrees with what the client paid for. */
  onReceiptMismatch?: (mismatch: {
    receipt: SessionReceipt;
    reasons: string[];
  }) => void;

  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
}

/** What a close attempt produced. */
export interface CloseOutcome {
  record: SessionRecord;
  response: Response;
  refundSats: number | null;
  refundStatus: string | null;
}

/** The transport a close uses, so the manager does not own fetching. */
export type SessionRequestSender = (input: {
  url: string;
  authorization: string;
}) => Promise<Response>;

/**
 * How many times a close will wait for a deposit to finish before giving up
 * and closing anyway. A caller that keeps starting deposits while closing
 * is not going to be talked out of it by waiting longer.
 */
const MAX_DEPOSIT_DRAINS = 8;

export class SessionManager {
  private readonly store: SessionStore;
  private readonly now: () => number;

  /**
   * Deposits in flight, keyed by session key. A caller that arrives while a
   * deposit is settling awaits this promise instead of starting its own,
   * which is what makes one session cost one payment no matter how many
   * requests raced into it.
   */
  private readonly inFlightDeposit = new Map<string, Promise<SessionRecord>>();

  /** Closes in flight, so a session is never closed twice concurrently. */
  private readonly inFlightClose = new Map<
    string,
    Promise<CloseOutcome | null>
  >();

  constructor(private readonly config: SessionManagerConfig) {
    this.store = config.store ?? new SessionCache();
    this.now = config.now ?? (() => Date.now());
  }

  /** Compute the key a session for this origin and realm is stored under. */
  static key(origin: string, realm: string): string {
    return SessionCache.key(origin, realm);
  }

  /** Whether this manager can safely take a session offer at all. */
  canOpenSessions(): boolean {
    return (
      this.config.minter !== undefined ||
      this.config.allowSessionWithoutRefund === true
    );
  }

  /** The live session for a key, or null when there is none. */
  async get(key: string): Promise<SessionRecord | null> {
    const record = await this.store.get(key);
    if (record === null || record === undefined) return null;
    return record.closedAt === undefined ? record : null;
  }

  /** Satoshis the client believes the session still has available. */
  remainingSat(record: SessionRecord): number {
    return Math.max(0, record.depositedSat - record.spentEstimateSat);
  }

  /**
   * Whether the balance estimate has fallen too low to send another bearer
   * request. With no quoted unit price there is nothing to compare against,
   * so the client keeps spending and lets the server say when it is done.
   */
  needsTopUp(record: SessionRecord): boolean {
    const units = this.config.minUnitsRemaining ?? 1;
    if (units <= 0) return false;
    if (record.pricePerUnitSat === null || record.pricePerUnitSat <= 0) {
      return false;
    }

    return this.remainingSat(record) < record.pricePerUnitSat * units;
  }

  /** Build the bearer credential for an open session. */
  bearerCredential(record: SessionRecord): Credential<SessionPayload> {
    return buildSessionCredentialFromEcho(record.challenge, {
      action: "bearer",
      sessionId: record.sessionId,
    });
  }

  /**
   * Open a session against a challenge, or return the one another caller
   * opened while this one was waiting.
   *
   * The deposit is paid inside the coalesced region, so a session key never
   * has two deposits in flight at once.
   */
  async open(input: {
    key: string;
    origin: string;
    url: string;
    challenge: SessionChallenge;
  }): Promise<SessionRecord> {
    // The lookup for an existing session happens inside the coalesced
    // region rather than in front of it. Checking first would be a cheap
    // fast path, but it would also mean this call awaits something before
    // registering itself, and anything that inspects in-flight deposits in
    // that window would conclude there were none.
    return this.coalesceDeposit(input.key, async () => {
      const existing = await this.get(input.key);
      if (existing !== null) return existing;

      return this.payAndOpen(input);
    });
  }

  /**
   * Add funds to an existing session, or return the record another caller
   * topped up while this one was waiting.
   *
   * Like open, this coalesces rather than serializes: two requests that
   * both hit an empty balance should buy one top-up between them, and the
   * challenge belonging to whichever one loses the race is dropped.
   */
  async topUp(input: {
    key: string;
    url: string;
    challenge: SessionChallenge;
  }): Promise<SessionRecord> {
    return this.coalesceDeposit(input.key, async () => {
      const record = await this.get(input.key);
      if (record === null) {
        throw new Error("mpp: cannot top up a session that is not open");
      }

      return this.payAndTopUp(record, input);
    });
  }

  /**
   * Charge a request against the local balance estimate.
   *
   * This is bookkeeping, not accounting. The server prices the work and
   * settles the difference on its own schedule; all this does is keep the
   * client from cheerfully sending bearer requests against a balance it has
   * already spent.
   */
  async recordSpend(key: string, amountSat: number): Promise<void> {
    const record = await this.get(key);
    if (record === null) return;

    await this.store.put(key, {
      ...record,
      spentEstimateSat: record.spentEstimateSat + Math.max(0, amountSat),
      lastUsedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Replace the local estimate with the server's number.
   *
   * The server is authoritative about a balance it is the one debiting, so
   * whenever it says anything, the client's guess is discarded rather than
   * averaged against.
   */
  async reconcile(
    key: string,
    balance: { remainingSat?: number; spentSat?: number },
  ): Promise<void> {
    const record = await this.get(key);
    if (record === null) return;

    let spentEstimateSat = record.spentEstimateSat;
    if (balance.spentSat !== undefined) {
      spentEstimateSat = Math.max(0, balance.spentSat);
    } else if (balance.remainingSat !== undefined) {
      spentEstimateSat = Math.max(
        0,
        record.depositedSat - Math.max(0, balance.remainingSat),
      );
    }

    await this.store.put(key, { ...record, spentEstimateSat });
  }

  /**
   * Apply the server's mid-stream exhaustion notice, which reports what has
   * been spent from the current deposit and what the next unit costs.
   */
  async applyNeedTopUp(key: string, event: NeedTopUpEvent): Promise<void> {
    await this.reconcile(key, { spentSat: event.balanceSpent });
  }

  /**
   * Drop a session the server no longer recognizes.
   *
   * There is no refund to chase for a session the server says does not
   * exist, and keeping the record would only produce bearer credentials it
   * will keep refusing.
   */
  async forget(key: string): Promise<void> {
    await this.store.delete(key);
  }

  /** Every session this manager still believes is open. */
  async listOpen(): Promise<SessionRecord[]> {
    const all = await this.store.list();
    return all.filter((record) => record.closedAt === undefined);
  }

  /**
   * The session to try against a URL, before any challenge has named a
   * realm.
   *
   * A session is scoped to a realm, but a request has only an origin until
   * the server answers, so the most recently used session on that origin is
   * the best available guess. Guessing wrong costs one refused request,
   * whose challenge then names the realm and puts the client on the right
   * session. Guessing right is what keeps a session from spending a round
   * trip per request just to be told which realm it is in.
   */
  async findForOrigin(origin: string): Promise<SessionRecord | null> {
    const candidates = (await this.listOpen())
      .filter((record) => record.origin === origin)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

    return candidates[0] ?? null;
  }

  /**
   * Close a session and collect the refund.
   *
   * The close credential goes to the URL the session was opened against:
   * the protection space is what a session is scoped to, and that is the
   * only URL inside it the client is known to have reached. The record is
   * marked closed only once the server has answered successfully, because a
   * client that forgets a session the server still holds has thrown the
   * deposit away.
   */
  async close(
    key: string,
    send: SessionRequestSender,
  ): Promise<CloseOutcome | null> {
    const pending = this.inFlightClose.get(key);
    if (pending !== undefined) return pending;

    const work = (async () => {
      // Let any deposit finish first, so a close cannot race a top-up into
      // a balance the server has already refunded. Draining rather than
      // awaiting once, because a deposit that was queued behind the one
      // this awaited would otherwise settle into a closed session.
      for (let drain = 0; drain < MAX_DEPOSIT_DRAINS; drain++) {
        const deposit = this.inFlightDeposit.get(key);
        if (deposit === undefined) break;
        await deposit.catch(() => undefined);
      }

      const record = await this.get(key);
      if (record === null) return null;

      const credential = buildSessionCredentialFromEcho(record.challenge, {
        action: "close",
        sessionId: record.sessionId,
        preimage: record.depositPreimage,
      });

      const response = await send({
        url: record.openUrl,
        authorization: toAuthorizationHeader(credential),
      });

      return this.applyCloseResponse(record, response);
    })().finally(() => {
      this.inFlightClose.delete(key);
    });

    this.inFlightClose.set(key, work);
    return work;
  }

  /**
   * Close every session this manager still holds, refunds and all.
   *
   * One session that will not close does not stop the others. This runs on
   * the way out, where a network error against one seller should not cost
   * the refunds owed by every other seller, and a session that failed to
   * close is still in `listOpen` afterwards for a caller that wants to
   * retry or report it.
   */
  async closeAll(send: SessionRequestSender): Promise<CloseOutcome[]> {
    const outcomes: CloseOutcome[] = [];

    for (const record of await this.listOpen()) {
      try {
        const outcome = await this.close(record.key, send);
        if (outcome !== null) outcomes.push(outcome);
      } catch (err) {
        console.warn(
          `mpp: failed to close session ${record.sessionId}, its deposit ` +
            "stays with the seller until the idle timeout:",
          err,
        );
      }
    }

    return outcomes;
  }

  /**
   * Record the outcome of a close. Split out so a caller that already has a
   * close response in hand does not have to send another.
   */
  async applyCloseResponse(
    record: SessionRecord,
    response: Response,
  ): Promise<CloseOutcome> {
    const receipt = readReceipt<SessionReceipt>(response);

    if (receipt !== null) {
      const reasons = checkReceipt(receipt, {
        method: METHOD_LIGHTNING,
        reference: record.sessionId,
      });
      if (reasons.length > 0) {
        this.config.onReceiptMismatch?.({ receipt, reasons });
      }
    }

    if (response.ok) {
      await this.store.put(record.key, {
        ...record,
        closedAt: new Date(this.now()).toISOString(),
      });
    }

    // A close with nothing left to send back reports a status and omits
    // the amount, so an absent refundSats alongside a status is zero rather
    // than unknown.
    const refund = receipt === null ? null : readRefund(receipt);

    return {
      record,
      response,
      refundSats: refund?.refundSats ?? null,
      refundStatus: refund?.refundStatus ?? null,
    };
  }

  private async payAndOpen(input: {
    key: string;
    origin: string;
    url: string;
    challenge: SessionChallenge;
  }): Promise<SessionRecord> {
    const { challenge } = input;
    const request = challenge.request;

    const invoice = request.depositInvoice ?? "";
    if (invoice === "") {
      throw new Error(
        "mpp: session challenge carries no deposit invoice to open with",
      );
    }

    const depositSat = await this.authorizeDeposit(input.url, challenge);

    // Mint the refund invoice before spending anything. A deposit paid with
    // nowhere for the remainder to go is a deposit the client cannot get
    // back, so that failure belongs before the payment, not after it.
    const returnInvoice = await this.mintReturnInvoice(
      input.origin,
      challenge.params.realm,
      request.description,
    );

    const payment = await this.config.payer.payInvoice({
      invoice,
      amountSat: depositSat,
      challengeId: challenge.params.id,
    });

    const sessionId = await this.verifyPaymentHash(
      payment.preimageHex,
      request.paymentHash,
    );

    await this.recordPayment({
      paymentHash: sessionId,
      amountSat: depositSat,
      paidSat: payment.amountPaidSat,
      invoice,
      preimageHex: payment.preimageHex,
      url: input.url,
    });

    const timestamp = new Date(this.now()).toISOString();
    const record: SessionRecord = {
      key: input.key,
      sessionId,
      origin: input.origin,
      realm: challenge.params.realm,
      challenge: toChallengeEcho(challenge.params),
      pricePerUnitSat: parseDecimalSat(request.amount) ?? null,
      depositedSat: depositSat,
      spentEstimateSat: 0,
      returnInvoice,
      depositPreimage: payment.preimageHex,
      openUrl: input.url,
      openedAt: timestamp,
      lastUsedAt: timestamp,
    };

    await this.store.put(input.key, record);
    return record;
  }

  private async payAndTopUp(
    record: SessionRecord,
    input: { key: string; url: string; challenge: SessionChallenge },
  ): Promise<SessionRecord> {
    const { challenge } = input;
    const request = challenge.request;

    const invoice = request.depositInvoice ?? "";
    if (invoice === "") {
      throw new Error(
        "mpp: session challenge carries no invoice to top up with",
      );
    }

    const topUpSat = await this.authorizeDeposit(input.url, challenge);

    const payment = await this.config.payer.payInvoice({
      invoice,
      amountSat: topUpSat,
      challengeId: challenge.params.id,
    });

    // A top-up challenge names the payment hash of its own fresh invoice
    // rather than the session id, so this binds the preimage to the invoice
    // that was quoted without touching the session's identity.
    await this.verifyPaymentHash(payment.preimageHex, request.paymentHash);

    await this.recordPayment({
      paymentHash: await paymentHashFromPreimage(payment.preimageHex),
      amountSat: topUpSat,
      paidSat: payment.amountPaidSat,
      invoice,
      preimageHex: payment.preimageHex,
      url: input.url,
    });

    const updated: SessionRecord = {
      ...record,
      // Carry the fresh challenge forward: it is the most recent thing the
      // server signed for this realm, and bearer requests echo it.
      challenge: toChallengeEcho(challenge.params),
      pricePerUnitSat:
        parseDecimalSat(request.amount) ?? record.pricePerUnitSat,
      depositedSat: record.depositedSat + topUpSat,
      topUpPreimage: payment.preimageHex,
      lastUsedAt: new Date(this.now()).toISOString(),
    };

    await this.store.put(input.key, updated);
    return updated;
  }

  /**
   * Bound the deposit and put it in front of the buyer policy.
   *
   * Under a one-shot charge the policy guards every request, because every
   * request is a payment. Under a session the money only moves at open and
   * top-up while a bearer request costs nothing at the wallet, so this is
   * the moment the policy has to see, and the number it sees is the whole
   * deposit rather than the price of the request that triggered it.
   */
  private async authorizeDeposit(
    url: string,
    challenge: SessionChallenge,
  ): Promise<number> {
    const request = challenge.request;
    const stated = parseDecimalSat(request.depositAmount) ?? 0;
    const depositSat = requireBoundedAmount(
      resolveAmountSat(stated, request.depositInvoice ?? ""),
      "mpp session deposit",
    );

    if (this.config.buyerPolicy !== undefined) {
      await this.config.buyerPolicy.assertAllowed({
        url,
        host: new URL(url).hostname,
        amountSat: depositSat,
        routeId: challenge.params.realm || undefined,
      });
    }

    return depositSat;
  }

  private async mintReturnInvoice(
    origin: string,
    realm: string,
    memo: string | undefined,
  ): Promise<string> {
    if (this.config.minter === undefined) {
      if (this.config.allowSessionWithoutRefund !== true) {
        throw new Error(
          "mpp: no return invoice minter configured; opening a session " +
            "would forfeit the unspent deposit",
        );
      }
      return "";
    }

    const minted = await this.config.minter.mintAmountlessInvoice({
      origin,
      realm,
      memo,
    });

    if (typeof minted?.invoice !== "string" || minted.invoice === "") {
      throw new Error("mpp: return invoice minter produced no invoice");
    }

    return minted.invoice;
  }

  /**
   * Confirm that the preimage the wallet obtained hashes to the payment
   * hash the challenge quoted, and return that hash.
   *
   * This is the one identity check in the session flow that needs no trust
   * in the server at all: sha256 of the preimage is the payment hash, full
   * stop. A mismatch means the invoice that was paid is not the invoice the
   * challenge described, and no session gets built on top of that.
   */
  private async verifyPaymentHash(
    preimageHex: string,
    quoted: string,
  ): Promise<string> {
    const derived = await paymentHashFromPreimage(preimageHex);

    if (quoted !== "" && derived.toLowerCase() !== quoted.toLowerCase()) {
      throw new Error(
        `mpp: paid preimage hashes to ${derived}, but the challenge named ` +
          `payment hash ${quoted}`,
      );
    }

    return derived;
  }

  private async recordPayment(receipt: {
    paymentHash: string;
    amountSat: number;
    paidSat: number;
    invoice: string;
    preimageHex: string;
    url: string;
  }): Promise<void> {
    if (this.config.receiptStore === undefined) return;

    try {
      await this.config.receiptStore.store({
        ...receipt,
        timestamp: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      // The money has already moved. A ledger that refused the write is a
      // gap in the audit trail, which is bad, but losing the session that
      // deposit just bought would be worse.
      console.warn("mpp: session payment ledger write failed:", err);
    }
  }

  /**
   * Run `work` as the single occupant of this session key, handing every
   * concurrent caller the same result.
   */
  private async coalesceDeposit(
    key: string,
    work: () => Promise<SessionRecord>,
  ): Promise<SessionRecord> {
    const inFlight = this.inFlightDeposit.get(key);
    if (inFlight !== undefined) return inFlight;

    const pending = work().finally(() => {
      this.inFlightDeposit.delete(key);
    });
    this.inFlightDeposit.set(key, pending);

    return pending;
  }
}
