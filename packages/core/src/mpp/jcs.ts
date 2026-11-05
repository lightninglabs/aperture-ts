/**
 * JSON Canonicalization Scheme (RFC 8785) for the Machine Payments Protocol.
 *
 * A Payment challenge binds its parameters with an HMAC, and one of those
 * parameters is the base64url of a JCS-serialized JSON object. Two peers that
 * canonicalize differently compute different HMAC inputs, and the only
 * symptom is a challenge the server refuses with no explanation of why. So
 * this module follows RFC 8785 exactly, and the vector-driven tests in
 * `jcs.test.ts` pin that against the vectors the Go implementation in
 * aperture's `mpp` package generates and commits.
 *
 * Two rules are worth naming, because a canonicalizer written against a JSON
 * library rather than against the RFC gets both of them wrong:
 *
 *  1. Object member names sort by UTF-16 code unit, per section 3.2.3, not by
 *     code point. The two orders agree for every character below U+10000 and
 *     disagree above it: an astral character encodes in UTF-16 as a surrogate
 *     pair starting at U+D800, so it sorts before U+E000 rather than after.
 *
 *  2. Strings escape exactly what ECMAScript's `JSON.stringify` escapes, per
 *     section 3.2.2.2: the quotation mark, the reverse solidus, and the C0
 *     controls, preferring a two-character shorthand wherever one exists.
 *     Nothing else. In particular "<", ">", "&", U+2028, and U+2029 stay
 *     literal, even though Go's `encoding/json` escapes the first three for
 *     HTML safety and the last two for JSONP safety.
 *
 * The second rule is not academic. `description` is free-form text inside the
 * HMAC on both the charge and session requests, so a description as ordinary
 * as "Q&A endpoint" hashes differently under a canonicalizer that escapes the
 * ampersand than under one that does not.
 */

/** The JSON value domain this canonicalizer accepts. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * Serialize a value to its canonical JSON form.
 *
 * Object properties whose value is `undefined` are omitted, matching both
 * `JSON.stringify` and the `omitempty` behavior of the Go structs on the
 * other side of the wire. An `undefined` inside an array throws instead:
 * `JSON.stringify` would silently turn it into `null`, and a silent
 * substitution inside something that gets signed is the failure mode this
 * module exists to prevent.
 */
export function canonicalize(value: JsonValue): string {
  const out: string[] = [];
  writeValue(out, value);
  return out.join("");
}

/**
 * Parse raw JSON text and re-serialize it in canonical form.
 *
 * This is the counterpart of the reference implementation's
 * `CanonicalizeJSON`, and the operation a seller performs when it has a
 * request object as bytes rather than as a value.
 */
export function canonicalizeJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`jcs: failed to parse JSON: ${describeError(err)}`);
  }
  return canonicalize(parsed as JsonValue);
}

function writeValue(out: string[], value: JsonValue | undefined): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;

    case "number":
      out.push(formatNumber(value));
      return;

    case "string":
      out.push(escapeString(value));
      return;

    case "object":
      if (Array.isArray(value)) {
        writeArray(out, value);
      } else {
        writeObject(out, value as Record<string, JsonValue | undefined>);
      }
      return;

    default:
      throw new Error(
        `jcs: value of type ${typeof value} is not JSON-serializable`,
      );
  }
}

function writeArray(out: string[], values: JsonValue[]): void {
  out.push("[");
  values.forEach((element, index) => {
    if (index > 0) out.push(",");
    if (element === undefined) {
      throw new Error(`jcs: array element ${index} is undefined`);
    }
    writeValue(out, element);
  });
  out.push("]");
}

function writeObject(
  out: string[],
  object: Record<string, JsonValue | undefined>,
): void {
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort(compareUtf16);

  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) out.push(",");
    out.push(escapeString(key));
    out.push(":");
    writeValue(out, object[key]);
  });
  out.push("}");
}

/**
 * Order two strings by their UTF-16 code unit sequences, the ordering RFC
 * 8785 section 3.2.3 mandates for object member names.
 *
 * JavaScript's relational operators already compare UTF-16 code units, so
 * this is a thin wrapper rather than an algorithm. It exists as a named
 * export because the ordering is a protocol rule that a peer has to match,
 * and because the obvious-looking alternative, comparing code points, is
 * wrong: an astral character encodes as a surrogate pair starting at U+D800
 * and therefore sorts below U+E000, not above U+FFFF.
 */
export function compareUtf16(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Format a number per ECMAScript's `Number::toString`, which is the
 * algorithm RFC 8785 section 3.2.2.3 mandates: the shortest decimal string
 * that parses back to exactly this double.
 *
 * `String()` is that algorithm, so there is nothing to reimplement here.
 * Note that the shortest round-tripping string is not the exact decimal
 * value: 36028797018963968 is exactly representable, yet renders as
 * 36028797018963970, and the shorter string is the one JCS requires. That
 * costs this protocol nothing, because every monetary amount it defines
 * travels as a decimal string rather than as a JSON number.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`jcs: ${value} is not a finite number`);
  }

  // Both signed zeroes render as "0", which `Number::toString` already does:
  // it is step 2 of the algorithm, not an accident of the implementation. Go
  // needs an explicit case here because its own formatter would write "-0",
  // and there is nothing to mirror. A test pins it either way.
  return String(value);
}

/**
 * Escape exactly what ECMAScript's `JSON.stringify` escapes, which is what
 * RFC 8785 section 3.2.2.2 requires: the quotation mark, the reverse
 * solidus, and the C0 controls, preferring a two-character shorthand
 * wherever one exists.
 *
 * Everything else goes out literally, the solidus and U+007F included. Two
 * groups are easy to escape by accident, because a JSON library will do it
 * for you and the output still parses: "<", ">", and "&", which Go's
 * `encoding/json` escapes so its output is safe to inline in HTML, and
 * U+2028 and U+2029, which it escapes so its output is safe to inline in
 * JavaScript. Neither concern is this protocol's, and either one changes the
 * bytes the challenge id's HMAC is computed over.
 *
 * There are five shorthands, `\b`, `\f`, `\n`, `\r`, and `\t`. Spelling any
 * of them out as a six-character `\u00xx` escape parses back to the same
 * string but is a different sequence of bytes, which is the same failure in
 * the other direction.
 */
function escapeString(value: string): string {
  let out = '"';

  for (const char of value) {
    const code = char.codePointAt(0) as number;

    switch (char) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      default:
        break;
    }

    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }

    // A lone surrogate is not a character, and the two implementations
    // disagree on what to do with one: Go substitutes U+FFFD while
    // JavaScript emits an escape for the surrogate itself. Refuse rather
    // than silently sign different bytes than the peer would.
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error(
        `jcs: string contains an unpaired surrogate U+${code
          .toString(16)
          .toUpperCase()}`,
      );
    }

    out += char;
  }

  return `${out}"`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
