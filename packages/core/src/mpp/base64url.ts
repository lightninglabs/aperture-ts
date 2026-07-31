/**
 * base64url codec for the Machine Payments Protocol wire format.
 *
 * Every structured field the Payment auth scheme puts on the wire (the
 * challenge's `request` and `opaque` parameters, the credential in the
 * Authorization header, the Payment-Receipt header) is base64url encoded
 * without padding, per RFC 4648 section 5.
 *
 * Encoding always omits padding. Decoding accepts padding, because the Go
 * reference implementation strips trailing "=" before decoding and a peer
 * that pads must still be understood. Decoding rejects the standard base64
 * alphabet ("+" and "/"), because accepting it would let two different
 * encodings of the same bytes reach the server, and only one of them is the
 * one the server's HMAC was computed over.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reverse lookup from base64url character to its 6-bit value. */
const DECODE_TABLE: ReadonlyMap<string, number> = new Map(
  Array.from(ALPHABET, (char, index) => [char, index] as const),
);

/** Encode raw bytes as base64url without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += ALPHABET[b0 >> 2];

    if (b1 === undefined) {
      out += ALPHABET[(b0 & 0x03) << 4];
      break;
    }
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];

    if (b2 === undefined) {
      out += ALPHABET[(b1 & 0x0f) << 2];
      break;
    }
    out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += ALPHABET[b2 & 0x3f];
  }

  return out;
}

/** Encode a string's UTF-8 bytes as base64url without padding. */
export function encodeBase64UrlText(text: string): string {
  return encodeBase64Url(new TextEncoder().encode(text));
}

/**
 * Decode base64url into raw bytes.
 *
 * Throws on any character outside the base64url alphabet, on a length that
 * cannot be produced by any byte sequence, and on non-zero padding bits in
 * the final character. The last check matters because a lenient decoder
 * accepts several encodings of the same bytes, which turns a value the
 * server signed into a value the client can restate differently.
 */
export function decodeBase64Url(encoded: string): Uint8Array {
  const trimmed = encoded.replace(/=+$/, "");

  // Padding is accepted but not renegotiated. An input that pads has to pad
  // the way RFC 4648 says: at most two characters, bringing the whole string
  // to a multiple of four. Stripping whatever trailing "=" happens to be
  // there would let "aGVsbG8===" and "aGVsbG8" both stand for the same
  // bytes, which is the second-spelling problem this decoder exists to
  // refuse.
  const padding = encoded.length - trimmed.length;
  if (padding > 0) {
    if (padding > 2) {
      throw new Error(
        `mpp: base64url input has ${padding} padding characters, at most ` +
          "2 are allowed",
      );
    }
    if (encoded.length % 4 !== 0) {
      throw new Error(
        `mpp: padded base64url input has length ${encoded.length}, which ` +
          "is not a multiple of 4",
      );
    }
  }

  const remainder = trimmed.length % 4;
  if (remainder === 1) {
    throw new Error(
      `mpp: invalid base64url length ${trimmed.length}`,
    );
  }

  const byteLength = Math.floor((trimmed.length * 3) / 4);
  const bytes = new Uint8Array(byteLength);

  let accumulator = 0;
  let bitCount = 0;
  let offset = 0;

  for (const char of trimmed) {
    const value = DECODE_TABLE.get(char);
    if (value === undefined) {
      throw new Error(
        `mpp: invalid base64url character ${JSON.stringify(char)}`,
      );
    }

    accumulator = (accumulator << 6) | value;
    bitCount += 6;

    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset++] = (accumulator >> bitCount) & 0xff;
    }
  }

  // Any bits left over belong to a byte that was never completed, so they
  // must all be zero. Non-zero leftovers mean a second encoding of the same
  // bytes exists.
  if (bitCount > 0 && (accumulator & ((1 << bitCount) - 1)) !== 0) {
    throw new Error("mpp: base64url has non-zero trailing bits");
  }

  return bytes;
}

/**
 * Decode base64url and interpret the bytes as UTF-8 text.
 *
 * Invalid UTF-8 is rejected rather than replaced, so a mangled credential
 * fails at the decode instead of silently becoming a string full of
 * replacement characters that no longer parses as the JSON it should be.
 */
export function decodeBase64UrlText(encoded: string): string {
  const bytes = decodeBase64Url(encoded);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
