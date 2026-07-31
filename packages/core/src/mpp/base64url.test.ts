import { describe, it, expect, beforeAll } from "vitest";
import {
  decodeBase64Url,
  decodeBase64UrlText,
  encodeBase64Url,
  encodeBase64UrlText,
} from "./base64url.js";
import { loadGoVectors, type Base64Vector } from "./goVectors.js";

let vectors: Base64Vector[];

beforeAll(async () => {
  vectors = (await loadGoVectors()).base64url;
});

describe("base64url against Go reference vectors", () => {
  it("encodes every vector identically", () => {
    for (const v of vectors) {
      expect(encodeBase64Url(Uint8Array.from(v.bytes))).toBe(v.encoded);
    }
  });

  it("decodes every vector back to the original bytes", () => {
    for (const v of vectors) {
      expect(Array.from(decodeBase64Url(v.encoded))).toEqual(v.bytes);
    }
  });

  it("never emits padding", () => {
    for (const v of vectors) {
      expect(encodeBase64Url(Uint8Array.from(v.bytes))).not.toContain("=");
    }
  });
});

describe("base64url round trips", () => {
  it("round-trips every byte value across every alignment", () => {
    for (let length = 0; length <= 8; length++) {
      const bytes = Uint8Array.from(
        { length },
        (_, i) => (i * 37 + length * 11) % 256,
      );
      expect(Array.from(decodeBase64Url(encodeBase64Url(bytes)))).toEqual(
        Array.from(bytes),
      );
    }

    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodeBase64Url(encodeBase64Url(all)))).toEqual(
      Array.from(all),
    );
  });

  it("round-trips multi-byte UTF-8 text", () => {
    const text = '{"description":"café 中文 \u{1F600}"}';
    expect(decodeBase64UrlText(encodeBase64UrlText(text))).toBe(text);
  });
});

describe("base64url decoding rejects ambiguous input", () => {
  it("accepts padding, since a padding peer must still be understood", () => {
    expect(decodeBase64UrlText("aGVsbG8=")).toBe("hello");
    expect(decodeBase64UrlText("aGVsbG8")).toBe("hello");
  });

  it("rejects the standard base64 alphabet", () => {
    // "+" and "/" would decode to the same bytes as "-" and "_", giving a
    // second encoding of a value the server signed exactly one form of.
    expect(() => decodeBase64Url("ab+d")).toThrow(/invalid base64url/);
    expect(() => decodeBase64Url("ab/d")).toThrow(/invalid base64url/);
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => decodeBase64Url("!!!!")).toThrow(
      /invalid base64url character/,
    );
    expect(() => decodeBase64Url("ab c")).toThrow(
      /invalid base64url character/,
    );
    expect(() => decodeBase64Url("!!!invalid!!!")).toThrow(/base64url/);
  });

  it("rejects a length no byte sequence can produce", () => {
    expect(() => decodeBase64Url("a")).toThrow(/invalid base64url length/);
    expect(() => decodeBase64Url("abcde")).toThrow(
      /invalid base64url length/,
    );
  });

  it("rejects non-zero trailing bits", () => {
    // "aGVsbG9" decodes "hello" plus 2 leftover bits. Flipping those bits
    // gives a different string that a lenient decoder would map to the same
    // bytes, so both cannot be accepted.
    expect(decodeBase64UrlText("aGVsbG8")).toBe("hello");
    expect(() => decodeBase64Url("aGVsbG9")).toThrow(/trailing bits/);
  });

  it("rejects bytes that are not valid UTF-8 when decoding as text", () => {
    const invalid = encodeBase64Url(Uint8Array.from([0xff, 0xfe]));
    expect(() => decodeBase64UrlText(invalid)).toThrow();
  });
});
