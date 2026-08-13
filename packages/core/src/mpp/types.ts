/**
 * Wire types for the Machine Payments Protocol: the `Payment` HTTP
 * authentication scheme (draft-httpauth-payment-00) and its two Lightning
 * intents, charge (draft-lightning-charge-00) and session
 * (draft-lightning-session-00).
 *
 * These mirror the Go reference implementation in aperture's `mpp` package
 * field for field. Field names are the JSON names, so a structure here can
 * be handed straight to the canonicalizer or to `JSON.stringify`.
 */

/** The HTTP authentication scheme name the protocol registers. */
export const AUTH_SCHEME = "Payment";

/** Payment method identifier for Lightning Network payments. */
export const METHOD_LIGHTNING = "lightning";

/** One-shot payment intent: pay an invoice, get the resource. */
export const INTENT_CHARGE = "charge";

/** Prepaid balance intent: deposit once, spend down over many requests. */
export const INTENT_SESSION = "session";

/** Currency identifier for satoshis, the base unit for Lightning amounts. */
export const CURRENCY_SAT = "sat";

/** Header field carrying the server's proof that a payment settled. */
export const HEADER_PAYMENT_RECEIPT = "Payment-Receipt";

/** The only receipt status the protocol defines; receipts mean success. */
export const RECEIPT_STATUS_SUCCESS = "success";

/**
 * Auth-params carried in a `WWW-Authenticate: Payment` header.
 *
 * The server binds every field here into the challenge `id` with an HMAC, so
 * a client must echo them back byte for byte. `request` and `opaque` are
 * already base64url of canonical JSON; they are carried as opaque strings
 * precisely so that echoing cannot perturb them.
 */
export interface ChallengeParams {
  /** Server-computed identifier binding the rest of these parameters. */
  id: string;

  /** Protection space identifier per RFC 9110. */
  realm: string;

  /** Payment method identifier, "lightning" for every intent here. */
  method: string;

  /** Payment intent, "charge" or "session". */
  intent: string;

  /** base64url of the JCS-serialized method- and intent-specific request. */
  request: string;

  /** RFC 3339 timestamp after which the challenge is no longer valid. */
  expires?: string;

  /** Content digest of the request body, formatted per RFC 9530. */
  digest?: string;

  /** Human-readable description of what is being paid for. */
  description?: string;

  /** base64url of JCS-serialized server-defined correlation data. */
  opaque?: string;
}

/**
 * The challenge as echoed inside a credential.
 *
 * This is `ChallengeParams` minus nothing: the server reconstructs the
 * parameters from this object and recomputes the HMAC over them, so every
 * field that was present in the header must come back unchanged.
 */
export interface ChallengeEcho {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires?: string;
  description?: string;
  opaque?: string;
  digest?: string;
}

/** The decoded `Authorization: Payment` credential a client sends. */
export interface Credential<Payload = unknown> {
  /** The challenge parameters, echoed unchanged. */
  challenge: ChallengeEcho;

  /**
   * Optional payer identifier, recommended to be a W3C DID.
   *
   * This client leaves it unset. It is the first field in the stack that
   * would let a seller correlate a buyer across otherwise unlinkable
   * payments, and turning that on is a product decision rather than a
   * protocol default.
   */
  source?: string;

  /** Method- and intent-specific proof of payment. */
  payload: Payload;
}

/** The decoded `Payment-Receipt` header a server returns on success. */
export interface Receipt {
  /** Always "success"; receipts are only issued for settled payments. */
  status: string;

  /** Payment method that settled, "lightning" here. */
  method: string;

  /** RFC 3339 settlement timestamp. */
  timestamp: string;

  /** Method-specific reference: the payment hash, or the session id. */
  reference: string;

  /** The challenge this receipt settles, for audit and traceability. */
  challengeId?: string;
}

/** Lightning-specific fields of a charge request. */
export interface ChargeMethodDetails {
  /** BOLT11 payment request. Authoritative for every payment parameter. */
  invoice: string;

  /** Lowercase hex payment hash embedded in the invoice, for convenience. */
  paymentHash?: string;

  /** "mainnet", "regtest", or "signet"; "mainnet" when omitted. */
  network?: string;
}

/** The decoded `request` parameter for method=lightning, intent=charge. */
export interface ChargeRequest {
  /** Invoice amount in satoshis, as a decimal string. */
  amount: string;

  /** Unit for `amount`; "sat" for Lightning. */
  currency: string;

  /** Human-readable memo for the resource being paid for. */
  description?: string;

  /** Payment recipient in method-native format. */
  recipient?: string;

  /** Merchant reference such as an order id. */
  externalId?: string;

  methodDetails: ChargeMethodDetails;
}

/** The credential payload for the charge intent: the settled preimage. */
export interface ChargePayload {
  /** Lowercase hex 32-byte payment preimage revealed on HTLC settlement. */
  preimage: string;
}

/** The four credential actions the session intent defines. */
export type SessionAction = "open" | "bearer" | "topUp" | "close";

/** The decoded `request` parameter for method=lightning, intent=session. */
export interface SessionRequest {
  /** Cost per unit of service in satoshis, as a decimal string. */
  amount: string;

  /** Unit for `amount`; must be "sat". */
  currency: string;

  /** Human-readable description of the service. */
  description?: string;

  /** Label for the priced unit, such as "token" or "request". */
  unitType?: string;

  /** BOLT11 invoice to pay to open or top up. Absent on bearer challenges. */
  depositInvoice?: string;

  /** Lowercase hex payment hash of the deposit invoice. */
  paymentHash: string;

  /** Exact deposit amount in satoshis, as a decimal string. */
  depositAmount?: string;

  /** Server idle timeout for open sessions in seconds, as a decimal string. */
  idleTimeout?: string;
}

/** The credential payload for the session intent, discriminated by action. */
export interface SessionPayload {
  action: SessionAction;

  /** Hex preimage of the deposit invoice; used by open and close. */
  preimage?: string;

  /** The deposit invoice's payment hash; identifies the session. */
  sessionId?: string;

  /**
   * Amountless BOLT11 invoice minted by the client at open, which the
   * server pays with the unspent balance when the session closes. Sending
   * an amountless invoice is what lets the server choose the refund amount.
   */
  returnInvoice?: string;

  /** Hex preimage of the top-up invoice; used by topUp only. */
  topUpPreimage?: string;
}

/** A receipt for a session action, extending the base receipt on close. */
export interface SessionReceipt extends Receipt {
  /** Unspent balance refunded on close, in satoshis. */
  refundSats?: number;

  /** Outcome of the refund attempt on close. */
  refundStatus?: SessionRefundStatus;
}

/** The three outcomes a close receipt can report for its refund. */
export type SessionRefundStatus = "succeeded" | "failed" | "skipped";

/**
 * The SSE event a server emits when a streaming response runs the session
 * balance to zero mid-flight. The client tops up and resumes rather than
 * losing the stream.
 */
export interface NeedTopUpEvent {
  sessionId: string;

  /** Total satoshis spent from the current deposit at exhaustion. */
  balanceSpent: number;

  /** Satoshis needed for the next unit of service. */
  balanceRequired: number;
}

/** Base URI for the protocol's RFC 9457 problem types. */
export const PROBLEM_BASE_URI = "https://paymentauth.org/problems/";

/** Base URI for the Lightning method's problem types. */
export const PROBLEM_LIGHTNING_BASE_URI = `${PROBLEM_BASE_URI}lightning/`;

/** Problem types defined by draft-httpauth-payment-00 section 8.2. */
export const PROBLEM_PAYMENT_REQUIRED = `${PROBLEM_BASE_URI}payment-required`;
export const PROBLEM_PAYMENT_INSUFFICIENT = `${PROBLEM_BASE_URI}payment-insufficient`;
export const PROBLEM_PAYMENT_EXPIRED = `${PROBLEM_BASE_URI}payment-expired`;
export const PROBLEM_VERIFICATION_FAILED = `${PROBLEM_BASE_URI}verification-failed`;
export const PROBLEM_METHOD_UNSUPPORTED = `${PROBLEM_BASE_URI}method-unsupported`;
export const PROBLEM_MALFORMED_CREDENTIAL = `${PROBLEM_BASE_URI}malformed-credential`;
export const PROBLEM_INVALID_CHALLENGE = `${PROBLEM_BASE_URI}invalid-challenge`;

/** Lightning-specific problem types from the charge and session drafts. */
export const PROBLEM_LIGHTNING_MALFORMED = `${PROBLEM_LIGHTNING_BASE_URI}malformed-credential`;
export const PROBLEM_LIGHTNING_UNKNOWN_CHALLENGE = `${PROBLEM_LIGHTNING_BASE_URI}unknown-challenge`;
export const PROBLEM_LIGHTNING_INVALID_PREIMAGE = `${PROBLEM_LIGHTNING_BASE_URI}invalid-preimage`;
export const PROBLEM_LIGHTNING_EXPIRED_INVOICE = `${PROBLEM_LIGHTNING_BASE_URI}expired-invoice`;
export const PROBLEM_LIGHTNING_SESSION_NOT_FOUND = `${PROBLEM_LIGHTNING_BASE_URI}session-not-found`;
export const PROBLEM_LIGHTNING_SESSION_CLOSED = `${PROBLEM_LIGHTNING_BASE_URI}session-closed`;
export const PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE = `${PROBLEM_LIGHTNING_BASE_URI}insufficient-balance`;
export const PROBLEM_LIGHTNING_CHALLENGE_EXPIRED = `${PROBLEM_LIGHTNING_BASE_URI}challenge-expired`;
export const PROBLEM_LIGHTNING_INVALID_RETURN_INVOICE = `${PROBLEM_LIGHTNING_BASE_URI}invalid-return-invoice`;

/** An RFC 9457 problem details document, as returned alongside a 402. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  challengeId?: string;
}
