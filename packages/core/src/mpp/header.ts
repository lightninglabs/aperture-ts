/**
 * Header codecs for the `Payment` HTTP authentication scheme.
 *
 * Three headers carry the protocol: `WWW-Authenticate: Payment` announces a
 * challenge, `Authorization: Payment` returns a credential, and
 * `Payment-Receipt` returns proof that the payment settled.
 */

import {
  decodeBase64Url,
  decodeBase64UrlText,
  encodeBase64UrlText,
} from "./base64url.js";
import { canonicalize, type JsonValue } from "./jcs.js";
import {
  AUTH_SCHEME,
  RECEIPT_STATUS_SUCCESS,
  type ChallengeParams,
  type Credential,
  type Receipt,
  type SessionReceipt,
} from "./types.js";

/**
 * Largest credential this module will decode, matching the reference
 * implementation's limit. The bound is checked against the encoded length
 * so that an oversized credential is refused before it is expanded.
 */
const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** A `WWW-Authenticate` challenge, retaining the scheme it was issued under. */
export interface ParsedChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Split a `WWW-Authenticate` header value into its individual challenges.
 *
 * This has to be done by hand. A 402 may offer several intents at once, and
 * a server that emits them as separate header lines still arrives here as a
 * single comma-joined string, because that is how the Fetch API's `Headers`
 * exposes repeated fields. The result is a value like:
 *
 *     Payment id="a", realm="r", ..., Payment id="b", realm="r", ...
 *
 * where the boundary between two challenges is only recognizable as an
 * element whose first token is a scheme name rather than an auth-param.
 * Commas inside quoted strings, which any `description` may contain, must
 * not split anything.
 */
export function splitChallenges(headerValue: string): ParsedChallenge[] {
  const challenges: ParsedChallenge[] = [];
  let current: ParsedChallenge | null = null;

  for (const element of splitTopLevel(headerValue)) {
    const trimmed = element.trim();
    if (trimmed === "") continue;

    const scheme = leadingScheme(trimmed);
    if (scheme !== null) {
      current = { scheme: scheme.name, params: emptyParams() };
      challenges.push(current);

      // A token68 tail (`Basic YWJjZA`) ends its challenge on the spot,
      // and the reference scanner reads the data itself as opening yet
      // another challenge, so whatever params follow belong to that one.
      // Following along matters for more than fidelity: leaving `current`
      // pointing at an earlier Payment challenge would let params the
      // server's HMAC never covered attach to it, and a client that pays
      // against that challenge then echoes a credential the server is
      // guaranteed to refuse. A payment for a guaranteed rejection is the
      // expensive way to parse a header.
      if (scheme.token68 !== null) {
        current = { scheme: scheme.token68, params: emptyParams() };
        challenges.push(current);
        continue;
      }

      if (scheme.rest !== "") {
        assignParam(current.params, scheme.rest);
      }
      continue;
    }

    // An auth-param before any scheme token is not attributable to a
    // challenge, so it is dropped rather than guessed at.
    if (current === null) continue;
    assignParam(current.params, trimmed);
  }

  return challenges;
}

/**
 * Extract every `Payment` challenge from a `WWW-Authenticate` header value,
 * validating that the five required auth-params are present.
 *
 * Challenges under other schemes are skipped, so a server that offers both
 * L402 and Payment on the same response is handled without the caller
 * having to pre-filter. Malformed `Payment` challenges are also skipped
 * rather than thrown on: one unusable offer among several should not cost
 * the client the offers it could have satisfied.
 */
export function parsePaymentChallenges(
  headerValue: string,
): ChallengeParams[] {
  const out: ChallengeParams[] = [];

  for (const challenge of splitChallenges(headerValue)) {
    if (challenge.scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) {
      continue;
    }

    const params = toChallengeParams(challenge.params);
    if (params !== null) out.push(params);
  }

  return out;
}

/**
 * Parse the first `Payment` challenge out of a `WWW-Authenticate` value,
 * throwing when there is none. Use `parsePaymentChallenges` when the response
 * may carry more than one offer and the caller wants to choose.
 *
 * Challenges under other schemes are skipped rather than rejected. This is
 * not a nicety: aperture with `--enablempp` answers a 402 with an LSAT offer,
 * an L402 offer and a Payment offer, in that order, and the Fetch API joins
 * those three field lines into one string before a client ever sees them.
 * Insisting that the value open with `Payment` would fail on the very header
 * this parser exists to read.
 */
export function parseChallengeHeader(headerValue: string): ChallengeParams {
  const challenges = splitChallenges(headerValue);

  if (challenges.length === 0) {
    throw new Error("mpp: empty WWW-Authenticate value");
  }

  const offers = challenges.filter(
    (challenge) =>
      challenge.scheme.toLowerCase() === AUTH_SCHEME.toLowerCase(),
  );
  const first = offers[0];

  if (first === undefined) {
    throw new Error(`mpp: header does not use ${AUTH_SCHEME} scheme`);
  }

  // Take the first offer that is actually usable, so one malformed offer
  // among several does not deny the caller the ones it could satisfy.
  for (const offer of offers) {
    const params = toChallengeParams(offer.params);
    if (params !== null) return params;
  }

  const missing = REQUIRED_PARAMS.filter(
    (name) => (first.params[name] ?? "") === "",
  );
  throw new Error(
    `mpp: challenge missing ${missing.join(", ")} parameter(s)`,
  );
}

/**
 * Render challenge parameters as a `WWW-Authenticate` header value. Sellers
 * need this; buyers need it to build the fixtures their tests run against.
 */
export function formatChallengeHeader(params: ChallengeParams): string {
  const parts = [
    `id=${quote(params.id)}`,
    `realm=${quote(params.realm)}`,
    `method=${quote(params.method)}`,
    `intent=${quote(params.intent)}`,
    `request=${quote(params.request)}`,
  ];

  if (params.expires) parts.push(`expires=${quote(params.expires)}`);
  if (params.digest) parts.push(`digest=${quote(params.digest)}`);
  if (params.description) {
    parts.push(`description=${quote(params.description)}`);
  }
  if (params.opaque) parts.push(`opaque=${quote(params.opaque)}`);

  return `${AUTH_SCHEME} ${parts.join(", ")}`;
}

/**
 * Encode a credential as an `Authorization` header value.
 *
 * The credential's own bytes are not canonicalized: nothing signs them, and
 * the one field that is covered by the server's HMAC, the echoed challenge,
 * is carried through as the strings it arrived as. Key order below matches
 * the reference implementation's struct order so that a wire capture from
 * either side reads the same.
 */
export function encodeCredential(credential: Credential): string {
  const challenge = credential.challenge;

  const ordered: Record<string, unknown> = {
    challenge: dropUndefined({
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      expires: challenge.expires,
      description: challenge.description,
      opaque: challenge.opaque,
      digest: challenge.digest,
    }),
    source: credential.source,
    payload: credential.payload,
  };

  return encodeBase64UrlText(JSON.stringify(dropUndefined(ordered)));
}

/** Render a credential as a complete `Authorization` header value. */
export function formatAuthorizationHeader(credential: Credential): string {
  return `${AUTH_SCHEME} ${encodeCredential(credential)}`;
}

/**
 * Decode an `Authorization: Payment` header value back into a credential,
 * validating the fields the reference implementation requires. This is the
 * seller's half of the exchange, and the check a buyer's tests use to prove
 * that what it emitted is what a seller would accept.
 */
export function parseCredential<Payload = unknown>(
  headerValue: string,
): Credential<Payload> {
  const prefix = `${AUTH_SCHEME} `;
  if (headerValue.slice(0, prefix.length).toLowerCase() !==
      prefix.toLowerCase()) {
    throw new Error(
      `mpp: authorization header does not use ${AUTH_SCHEME} scheme`,
    );
  }

  const token = headerValue.slice(prefix.length).trim();
  if (token === "") {
    throw new Error("mpp: empty credential token");
  }

  // Reject by encoded length before decoding, so an oversized credential
  // never gets expanded into memory.
  const maxEncoded = Math.ceil((MAX_CREDENTIAL_BYTES * 4) / 3) + 4;
  if (token.length > maxEncoded) {
    throw new Error(
      `mpp: credential too large (${token.length} encoded bytes, max ` +
        `${maxEncoded})`,
    );
  }

  let decoded: string;
  try {
    decoded = decodeBase64UrlText(token);
  } catch (err) {
    throw new Error(
      `mpp: failed to decode credential token: ${describeError(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    throw new Error(
      `mpp: failed to unmarshal credential: ${describeError(err)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("mpp: credential is not a JSON object");
  }

  const challenge = parsed.challenge;
  if (!isRecord(challenge)) {
    throw new Error("mpp: credential missing challenge");
  }

  for (const field of REQUIRED_PARAMS) {
    if (typeof challenge[field] !== "string" || challenge[field] === "") {
      throw new Error(`mpp: credential missing challenge.${field}`);
    }
  }

  if (parsed.payload === undefined || parsed.payload === null) {
    throw new Error("mpp: credential missing payload");
  }

  return parsed as unknown as Credential<Payload>;
}

/** JCS-serialize a request object and base64url it for the wire. */
export function encodeRequestObject(value: JsonValue): string {
  return encodeBase64UrlText(canonicalize(value));
}

/**
 * Decode a challenge's `request` or `opaque` parameter.
 *
 * The bytes are parsed, not re-canonicalized: the encoded string is what the
 * server's HMAC covers, so a client that round-trips through its own
 * canonicalizer risks echoing back something subtly different.
 */
export function decodeRequestObject<T>(encoded: string): T {
  let decoded: string;
  try {
    decoded = decodeBase64UrlText(encoded);
  } catch (err) {
    throw new Error(`mpp: failed to decode request: ${describeError(err)}`);
  }

  try {
    return JSON.parse(decoded) as T;
  } catch (err) {
    throw new Error(`mpp: failed to unmarshal request: ${describeError(err)}`);
  }
}

/**
 * Encode a receipt as a `Payment-Receipt` header value.
 *
 * Key order comes from the receipt's contents rather than from the order the
 * caller happened to build the object in, the same discipline
 * `encodeCredential` holds and for the same reason: a wire capture taken on
 * either side of the exchange should read the same. Nothing signs a receipt,
 * so this costs nothing if it is wrong; it is here so the byte-for-byte
 * claim these codecs make is one claim rather than two.
 *
 * The reference implementation declares two receipt structs, and they do not
 * agree on order. A receipt carrying either refund field is a session
 * receipt and takes the session order. One case is invisible to that test: a
 * session receipt for an action with no refund, which is emitted in the base
 * order here and in the session order by the reference.
 */
export function encodeReceipt(receipt: Receipt): string {
  const isSession =
    (receipt as SessionReceipt).refundSats !== undefined ||
    (receipt as SessionReceipt).refundStatus !== undefined;

  const fields = receipt as unknown as Record<string, unknown>;
  const order = isSession ? SESSION_RECEIPT_ORDER : RECEIPT_ORDER;
  const ordered: Record<string, unknown> = {};

  for (const field of order) {
    const value = fields[field];
    if (value !== undefined) ordered[field] = value;
  }

  // Anything the reference does not declare still goes out, after the fields
  // it does, so an extension field is reordered rather than dropped.
  for (const [key, value] of Object.entries(receipt)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }

  return encodeBase64UrlText(JSON.stringify(ordered));
}

/** Field order of the reference implementation's base receipt struct. */
const RECEIPT_ORDER = [
  "status",
  "method",
  "timestamp",
  "reference",
  "challengeId",
] as const;

/** Field order of the reference implementation's session receipt struct. */
const SESSION_RECEIPT_ORDER = [
  "method",
  "reference",
  "status",
  "timestamp",
  "refundSats",
  "refundStatus",
] as const;

/**
 * Decode a `Payment-Receipt` header value.
 *
 * The status is checked here because the protocol defines exactly one, and a
 * receipt claiming anything else is not a receipt this client should record
 * as proof of a settled payment.
 */
export function parseReceiptHeader<T extends Receipt = Receipt>(
  headerValue: string,
): T {
  let decoded: string;
  try {
    decoded = decodeBase64UrlText(headerValue);
  } catch (err) {
    throw new Error(`mpp: failed to decode receipt: ${describeError(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    throw new Error(
      `mpp: failed to unmarshal receipt: ${describeError(err)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("mpp: receipt is not a JSON object");
  }
  for (const field of ["status", "method", "reference"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field] === "") {
      throw new Error(`mpp: receipt missing ${field}`);
    }
  }

  if (parsed.status !== RECEIPT_STATUS_SUCCESS) {
    throw new Error(
      `mpp: receipt status is ${JSON.stringify(parsed.status)}, and the ` +
        `protocol defines only ${JSON.stringify(RECEIPT_STATUS_SUCCESS)}`,
    );
  }

  return parsed as unknown as T;
}

/** Decode a base64url `opaque` parameter to raw bytes. */
export function decodeOpaque(encoded: string): Uint8Array {
  return decodeBase64Url(encoded);
}

const REQUIRED_PARAMS = [
  "id",
  "realm",
  "method",
  "intent",
  "request",
] as const;

function toChallengeParams(
  params: Record<string, string>,
): ChallengeParams | null {
  for (const name of REQUIRED_PARAMS) {
    if ((params[name] ?? "") === "") return null;
  }

  const out: ChallengeParams = {
    id: params.id as string,
    realm: params.realm as string,
    method: params.method as string,
    intent: params.intent as string,
    request: params.request as string,
  };

  if (params.expires) out.expires = params.expires;
  if (params.digest) out.digest = params.digest;
  if (params.description) out.description = params.description;
  if (params.opaque) out.opaque = params.opaque;

  return out;
}

/**
 * Split a header value at commas that sit outside a quoted string. A
 * `description` containing a comma is common enough that naive splitting
 * would corrupt real challenges.
 */
function splitTopLevel(value: string): string[] {
  const elements: string[] = [];
  let start = 0;
  let inQuotes = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (inQuotes) {
      if (char === "\\") {
        i++;
      } else if (char === '"') {
        inQuotes = false;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      elements.push(value.slice(start, i));
      start = i + 1;
    }
  }

  elements.push(value.slice(start));
  return elements;
}

/**
 * Recognize an element that begins a new challenge, which is one whose first
 * whitespace-delimited token is a bare scheme name rather than the left side
 * of an auth-param. Returns the scheme, whatever followed it on the same
 * element as that challenge's first auth-param, and, when the tail carries
 * no `=` at all, the token68 data of a challenge in the `scheme token68`
 * form.
 */
function leadingScheme(
  element: string,
): { name: string; rest: string; token68: string | null } | null {
  const match = element.match(/^([A-Za-z0-9!#$%&'*+\-.^_`|~]+)(\s+([\s\S]*))?$/);
  if (!match) return null;

  const name = match[1] as string;
  const rest = (match[3] ?? "").trim();

  // A remainder that opens with "=" means the element is really an
  // auth-param written with spaces around its equals sign, as in
  // `realm = "example.com"`, not a scheme followed by its first parameter.
  if (rest.startsWith("=")) return null;

  // A tail with no "=" anywhere is token68 data, as in `Basic YWJjZA`: a
  // complete challenge whose scheme is `name` and whose data this parser
  // has no use for.
  if (rest !== "" && !rest.includes("=")) {
    return { name, rest: "", token68: rest };
  }

  return { name, rest, token68: null };
}

/**
 * Build the map an auth-param set accumulates into.
 *
 * The prototype has to go. Duplicate detection below asks whether a key is
 * already present with `in`, which walks the prototype chain of an ordinary
 * object literal, so a challenge carrying a parameter named `constructor`,
 * `toString` or `valueOf` would look like a repeat of something never seen
 * and be dropped. None of the parameters this protocol defines collide, but
 * the extension parameters it invites are written by whoever wants one, and
 * a null prototype costs nothing to be right about.
 */
function emptyParams(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Parse one `key=value` or `key="value"` auth-param into the map. */
function assignParam(params: Record<string, string>, element: string): void {
  const equals = element.indexOf("=");
  if (equals < 0) return;

  const key = element.slice(0, equals).trim().toLowerCase();
  if (key === "") return;

  const raw = element.slice(equals + 1).trim();

  // Later duplicates are ignored: taking the first occurrence means a
  // parameter appended to a challenge cannot displace the one the server's
  // HMAC covered.
  if (key in params) return;

  params[key] = raw.startsWith('"') ? unquote(raw) : raw;
}

/**
 * Unwrap an RFC 9110 quoted-string, resolving backslash escapes.
 *
 * The reference implementation's parser stops at the first unescaped-looking
 * quote and keeps the backslash, but nothing depends on that: a server
 * recomputes the HMAC from the JSON-decoded credential, where the value is
 * already unescaped. Resolving escapes here is what makes the echoed value
 * match what the server originally signed.
 */
function unquote(value: string): string {
  let out = "";

  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      out += value[i + 1] as string;
      i++;
      continue;
    }
    if (char === '"') break;
    out += char;
  }

  return out;
}

/** Wrap a value in a quoted-string, escaping backslashes and quotes. */
function quote(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
