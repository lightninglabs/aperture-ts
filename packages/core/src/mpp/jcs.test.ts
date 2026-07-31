/**
 * JCS tests. The vector-driven suite proves byte agreement with the Go
 * reference implementation; the property suite hunts for the ordering and
 * escaping bugs that a fixed vector list will not stumble onto.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { canonicalize, canonicalizeJson, compareCodePoints } from "./jcs.js";
import { encodeBase64UrlText } from "./base64url.js";
import { loadGoVectors, type JcsVector } from "./goVectors.js";

let vectors: JcsVector[];

beforeAll(async () => {
  vectors = (await loadGoVectors()).jcs;
});

describe("canonicalizeJson against Go reference vectors", () => {
  it("loads a non-trivial vector set", () => {
    expect(vectors.length).toBeGreaterThan(20);
  });

  it("reproduces every canonical form byte for byte", () => {
    const mismatches = vectors
      .filter((v) => canonicalizeJson(v.input) !== v.canonical)
      .map((v) => ({
        name: v.name,
        want: v.canonical,
        got: canonicalizeJson(v.input),
      }));

    expect(mismatches).toEqual([]);
  });

  it("reproduces the base64url of every canonical form", () => {
    for (const v of vectors) {
      expect(encodeBase64UrlText(canonicalizeJson(v.input))).toBe(v.encoded);
    }
  });

  it("is idempotent: canonicalizing canonical output changes nothing", () => {
    for (const v of vectors) {
      expect(canonicalizeJson(v.canonical)).toBe(v.canonical);
    }
  });
});

describe("canonicalize divergences from RFC 8785 that match the reference", () => {
  it("escapes the HTML-sensitive characters Go escapes", () => {
    // RFC 8785 would leave all three literal. Go's encoding/json escapes
    // them, so a canonicalizer that follows the RFC here would compute a
    // different HMAC input than the server it is talking to.
    expect(canonicalize({ s: "a/b&c<d>e" })).toBe(
      '{"s":"a/b\\u0026c\\u003cd\\u003ee"}',
    );
  });

  it("escapes the two line separators", () => {
    const separators = "a\u2028b\u2029c";
    expect(canonicalize({ s: separators })).toBe(
      '{"s":"a\\u2028b\\u2029c"}',
    );
  });

  it("orders keys by code point, not by UTF-16 code unit", () => {
    // A UTF-16 comparison sorts the astral character first, because its
    // leading surrogate 0xD83D is below 0xFFFD. Code point order, which is
    // what Go's byte-wise sort produces, puts it last.
    const canonical = canonicalize({
      "\u{1F600}": "emoji",
      "\uFFFD": "replacement",
      a: "ascii",
    });

    expect(canonical).toBe(
      '{"a":"ascii","\uFFFD":"replacement","\u{1F600}":"emoji"}',
    );
    expect(canonical.indexOf("\uFFFD")).toBeLessThan(
      canonical.indexOf("\u{1F600}"),
    );
  });
});

describe("canonicalize value handling", () => {
  it("keeps array order while sorting object keys", () => {
    expect(canonicalize({ items: ["c", "a", "b"], b: 1, a: 2 })).toBe(
      '{"a":2,"b":1,"items":["c","a","b"]}',
    );
  });

  it("omits undefined properties rather than emitting null", () => {
    expect(canonicalize({ a: "1", b: undefined })).toBe('{"a":"1"}');
  });

  it("rejects undefined inside an array instead of coercing it to null", () => {
    expect(() =>
      canonicalize({ items: ["a", undefined as never, "b"] }),
    ).toThrow(/array element 1 is undefined/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(
      /finite/,
    );
  });

  it("rejects unpaired surrogates rather than diverging from Go", () => {
    // Go substitutes U+FFFD for an unpaired surrogate while JavaScript would
    // escape the surrogate itself, so the two sides would sign different
    // bytes. Refusing is the only outcome that cannot silently diverge.
    expect(() => canonicalize({ s: "\uD800" })).toThrow(/unpaired surrogate/);
  });

  it("normalizes negative zero the way both implementations do", () => {
    expect(canonicalize({ a: -0 })).toBe('{"a":0}');
  });

  it("rejects malformed JSON text with a useful message", () => {
    expect(() => canonicalizeJson("{invalid")).toThrow(/failed to parse JSON/);
  });
});

describe("compareCodePoints", () => {
  it("is a total order consistent with sorting", () => {
    const input = ["b", "a", "", "aa", "A", "\u{1F600}", "\uFFFD", "z"];
    const sorted = [...input].sort(compareCodePoints);

    for (let i = 1; i < sorted.length; i++) {
      expect(
        compareCodePoints(sorted[i - 1] as string, sorted[i] as string),
      ).toBeLessThanOrEqual(0);
    }
  });

  it("is antisymmetric", () => {
    const pairs: Array<[string, string]> = [
      ["a", "b"],
      ["\u{1F600}", "\uFFFD"],
      ["abc", "ab"],
      ["", "a"],
    ];

    for (const [a, b] of pairs) {
      expect(Math.sign(compareCodePoints(a, b))).toBe(
        -Math.sign(compareCodePoints(b, a)),
      );
    }
  });
});

/**
 * Property tests. Each generates structurally random JSON and checks an
 * invariant that must hold for every input, rather than for the handful the
 * vector list happens to name.
 */
describe("canonicalize properties", () => {
  const ITERATIONS = 300;

  it("is invariant under property insertion order", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const rng = makeRng(seed);
      const value = randomJson(rng, 3);

      const shuffled = shuffleKeys(value, makeRng(seed + 10_000));
      expect(canonicalize(shuffled)).toBe(canonicalize(value));
    }
  });

  it("is idempotent under a parse and re-canonicalize round trip", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const canonical = canonicalize(randomJson(makeRng(seed), 3));
      expect(canonicalizeJson(canonical)).toBe(canonical);
    }
  });

  it("produces output that parses back to an equal value", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const value = randomJson(makeRng(seed), 3);
      expect(JSON.parse(canonicalize(value))).toEqual(
        JSON.parse(JSON.stringify(value)),
      );
    }
  });

  it("emits object keys in non-decreasing code point order", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const value = randomJson(makeRng(seed), 3);
      assertKeysSorted(JSON.parse(canonicalize(value)));
    }
  });

  it("distinguishes values that differ, for every generated pair", () => {
    // Canonical forms are compared for equality by the HMAC, so two
    // different logical values must not share one.
    const seen = new Map<string, unknown>();

    for (let seed = 0; seed < ITERATIONS; seed++) {
      const value = randomJson(makeRng(seed), 3);
      const canonical = canonicalize(value);
      const previous = seen.get(canonical);

      if (previous !== undefined) {
        expect(JSON.parse(JSON.stringify(previous))).toEqual(
          JSON.parse(JSON.stringify(value)),
        );
      }
      seen.set(canonical, value);
    }
  });
});

/** Deterministic 32-bit PRNG, so a failing property test is reproducible. */
function makeRng(seed: number): () => number {
  let state = (seed + 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * The character pool the generators draw from. It leans on the characters
 * that have historically broken canonicalizers: the escape-triggering ones,
 * the HTML-sensitive ones, non-ASCII, and one astral character to exercise
 * the code point ordering.
 */
const CHARS = Array.from(
  'ab-_ AZ09"\\\n\t<>&\u00e9\u4e2d\uFFFD\u{1F600}\u2028',
)

function randomString(rng: () => number, maxLength: number): string {
  const length = Math.floor(rng() * maxLength);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARS[Math.floor(rng() * CHARS.length)] as string;
  }
  return out;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function randomJson(rng: () => number, depth: number): Json {
  const choice = Math.floor(rng() * (depth > 0 ? 7 : 5));

  switch (choice) {
    case 0:
      return null;
    case 1:
      return rng() < 0.5;
    case 2:
      return Math.floor(rng() * 2_000_000) - 1_000_000;
    case 3:
      return Math.round((rng() * 2000 - 1000) * 1000) / 1000;
    case 4:
      return randomString(rng, 8);
    case 5: {
      const length = Math.floor(rng() * 4);
      return Array.from({ length }, () => randomJson(rng, depth - 1));
    }
    default: {
      const size = Math.floor(rng() * 5);
      const out: { [k: string]: Json } = {};
      for (let i = 0; i < size; i++) {
        out[randomString(rng, 6)] = randomJson(rng, depth - 1);
      }
      return out;
    }
  }
}

/** Rebuild an object graph with its property insertion order permuted. */
function shuffleKeys(value: Json, rng: () => number): Json {
  if (Array.isArray(value)) {
    return value.map((element) => shuffleKeys(element, rng));
  }
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [entries[i], entries[j]] = [entries[j] as never, entries[i] as never];
  }

  const out: { [k: string]: Json } = {};
  for (const [key, entry] of entries) {
    out[key] = shuffleKeys(entry as Json, rng);
  }
  return out;
}

function assertKeysSorted(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertKeysSorted);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const keys = Object.keys(value);
  for (let i = 1; i < keys.length; i++) {
    expect(
      compareCodePoints(keys[i - 1] as string, keys[i] as string),
    ).toBeLessThan(0);
  }
  Object.values(value).forEach(assertKeysSorted);
}
