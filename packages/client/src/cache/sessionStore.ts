/**
 * Storage for open payment sessions: the contract the session manager
 * consumes, and the default in-memory implementation.
 *
 * A session holds real money. The deposit sits with the seller until the
 * client closes the session and the seller pays the unspent balance back to
 * the return invoice, and the only thing that can ask for that to happen is
 * a client that still knows the session id. A process that forgets a
 * session id has not lost a cache entry, it has lost the refund. So the
 * default here is deliberately the weakest useful implementation, and
 * anything that survives a restart is expected to inject its own.
 */

import type { ChallengeEcho } from "@lightninglabs/aperture-core/mpp";

/** Everything needed to keep spending a session, and to close it later. */
export interface SessionRecord {
  /** Cache key: origin and realm, the scope a session is valid over. */
  key: string;

  /**
   * The session identifier, which is the payment hash of the deposit
   * invoice. The client derives this from the preimage it paid rather than
   * taking the server's word for it.
   */
  sessionId: string;

  /** Origin (scheme, host, port) the session was opened against. */
  origin: string;

  /** Protection space the session covers. */
  realm: string;

  /**
   * The challenge echo to send on bearer requests.
   *
   * A bearer request presents no fresh challenge of its own, so it echoes
   * the one the session was opened or last topped up against. The server
   * recomputes its HMAC over these parameters, which is why they are stored
   * verbatim rather than rebuilt.
   */
  challenge: ChallengeEcho;

  /** Advertised cost per unit of service, or null when not quoted. */
  pricePerUnitSat: number | null;

  /** Total satoshis paid into the session across the open and any top-ups. */
  depositedSat: number;

  /**
   * Local estimate of what has been spent.
   *
   * An estimate is all it can be. The server prices metered work after the
   * fact and settles the difference later, so this number tracks the
   * client's expectation and yields to the server's whenever the two
   * disagree.
   */
  spentEstimateSat: number;

  /** Amountless invoice the server pays the unspent balance to on close. */
  returnInvoice: string;

  /**
   * Preimage of the deposit invoice, which the close credential presents as
   * proof that the party asking for the refund is the one that funded the
   * session. It is a bearer secret with the deposit's value behind it, so a
   * durable store has to protect it the way it would protect a key.
   */
  depositPreimage: string;

  /** Preimage of the most recent top-up invoice, when there has been one. */
  topUpPreimage?: string;

  /**
   * The deposit handshake the server has not yet acknowledged, when one is
   * outstanding.
   *
   * Paying a deposit is only half of what makes it a balance. The server
   * learns about the money from the credential that proves it: an `open`
   * carries the deposit preimage and the return invoice, a `topUp` carries
   * the top-up preimage, and until the server has answered one of those, a
   * bearer credential names a balance the server does not know about. So
   * while this field is set, the next request presents this handshake
   * instead of a bearer credential.
   *
   * The challenge is pinned here rather than read from `challenge` above,
   * because the server verifies the handshake's preimage against the
   * challenge the deposit was paid against, while `challenge` moves on
   * whenever a fresher offer for the realm arrives.
   */
  pendingHandshake?: {
    action: "open" | "topUp";
    challenge: ChallengeEcho;
  };

  /** URL the session was opened against, where a close is sent by default. */
  openUrl: string;

  openedAt: string;
  lastUsedAt: string;

  /** Set once the server has confirmed the close. */
  closedAt?: string;
}

/**
 * The storage contract the session manager uses.
 *
 * Implementations may be synchronous or asynchronous; every call site
 * awaits. `list` is not optional: closing every open session on shutdown is
 * the only way the deposits come back, and that cannot be done against a
 * store that cannot enumerate.
 */
export interface SessionStore {
  get(key: string): SessionRecord | null | Promise<SessionRecord | null>;
  put(key: string, record: SessionRecord): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  list(): SessionRecord[] | Promise<SessionRecord[]>;
}

/** Process-local session store. Loses every open deposit on restart. */
export class SessionCache implements SessionStore {
  private sessions = new Map<string, SessionRecord>();

  /**
   * Compute the key a session is stored under. Origin and realm together
   * are the scope: the realm is the protection space the server named, and
   * the origin keeps two servers that happen to use the same realm name
   * from sharing a deposit.
   */
  static key(origin: string, realm: string): string {
    return `${origin}|${realm}`;
  }

  get(key: string): SessionRecord | null {
    return this.sessions.get(key) ?? null;
  }

  put(key: string, record: SessionRecord): void {
    this.sessions.set(key, record);
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  get size(): number {
    return this.sessions.size;
  }
}
