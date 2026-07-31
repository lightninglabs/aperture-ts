/**
 * JCS tests. The vector-driven suite proves byte agreement with the Go
 * reference implementation; the property suite hunts for the ordering and
 * escaping bugs that a fixed vector list will not stumble onto.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { canonicalize, canonicalizeJson, compareUtf16 } from "./jcs.js";
import { loadGoVectors, type CanonicalVector } from "./goVectors.js";

let vectors: CanonicalVector[];

beforeAll(async () => {
  vectors = (await loadGoVectors()).canonicalization;
});

describe("canonicalizeJson against the Go vector file", () => {
  it("loads a non-trivial vector set", () => {
    expect(vectors.length).toBeGreaterThan(20);
    expect(vectors.some((v) => v.error === true)).toBe(true);
  });

  it("reproduces every canonical form byte for byte", () => {
    const mismatches = vectors
      .filter((v) => v.error !== true)
      .filter((v) => canonicalizeJson(v.input) !== v.canonical)
      .map((v) => ({
        name: v.name,
        want: v.canonical,
        got: canonicalizeJson(v.input),
      }));

    expect(mismatches).toEqual([]);
  });

  it("refuses every input the reference refuses", () => {
    const accepted = vectors
      .filter((v) => v.error === true)
      .filter((v) => {
        try {
          canonicalizeJson(v.input);
          return true;
        } catch {
          return false;
        }
      })
      .map((v) => v.name);

    expect(accepted).toEqual([]);
  });

  it("is idempotent: canonicalizing canonical output changes nothing", () => {
    for (const v of vectors) {
      if (v.error === true) continue;
      expect(canonicalizeJson(v.canonical as string)).toBe(v.canonical);
    }
  });
});

describe("canonicalize escaping, per RFC 8785 section 3.2.2.2", () => {
  it("leaves the HTML-sensitive characters literal", () => {
    // A canonicalizer built on a JSON library inherits that library's
    // HTML-safety escaping, and the output still parses, so nothing short of
    // a byte comparison notices. `description` is free-form text inside the
    // HMAC, which is how a description as ordinary as "Q&A endpoint" ends up
    // hashing differently on the two sides.
    expect(canonicalize({ s: "a/b&c<d>e" })).toBe('{"s":"a/b&c<d>e"}');
  });

  it("leaves the two line separators literal", () => {
    // Go's encoding/json escapes these so its output can be inlined in a
    // JavaScript source file. That is not a concern this protocol has, and
    // JSON.stringify, which the RFC defers to, leaves them alone.
    const separators = "a\u2028b\u2029c";
    expect(canonicalize({ s: separators })).toBe(`{"s":"${separators}"}`);
  });

  it("leaves the solidus and U+007F literal", () => {
    expect(canonicalize({ s: "a/b\u007f" })).toBe('{"s":"a/b\u007f"}');
  });

  it("uses the short form for every control character that has one", () => {
    // Both the reference implementation and RFC 8785 write these five as
    // two characters. Backspace and form feed are the two that a
    // canonicalizer is likely to get wrong, because they are the two the
    // protocol's own payloads never contain, so nothing on a live wire
    // would ever report the divergence.
    expect(canonicalize({ s: "\b\f\n\r\t" })).toBe('{"s":"\\b\\f\\n\\r\\t"}');
  });

  it("spells out the C0 controls that have no short form", () => {
    // Everything below 0x20 that is not one of the five, lowercase hex and
    // padded to four digits, which is what Go's `\u00xx` produces.
    expect(canonicalize({ s: "\u0000\u000b\u001b\u001f" })).toBe(
      '{"s":"\\u0000\\u000b\\u001b\\u001f"}',
    );
  });
});

describe("canonicalize member ordering, per RFC 8785 section 3.2.3", () => {
  it("orders keys by UTF-16 code unit, not by code point", () => {
    // The whole disagreement between the two orderings lives in this one
    // range. An astral character encodes in UTF-16 as a surrogate pair
    // starting at U+D800, so it sorts below U+E000, while a code point
    // comparison puts it above everything in the basic multilingual plane.
    const canonical = canonicalize({
      "\uE000": "private use",
      "\u{10000}": "astral",
      "\uFFFF": "noncharacter",
      "\uD7FF": "below the surrogates",
    });

    expect(canonical).toBe(
      '{"\uD7FF":"below the surrogates","\u{10000}":"astral",' +
        '"\uE000":"private use","\uFFFF":"noncharacter"}',
    );
  });

  it("agrees with what JavaScript's own sort would do", () => {
    // RFC 8785 chose UTF-16 order precisely because it is what a JavaScript
    // peer produces for free, so anything more elaborate than a plain
    // comparison here would be a way to get it wrong.
    const keys = ["\uE000", "\u{10000}", "\uFFFF", "\uD7FF", "a", "", "Z"];
    const object = Object.fromEntries(keys.map((k) => [k, 1]));

    const emitted = objectKeyOrders(canonicalize(object))[0] as string[];
    expect(emitted).toEqual([...keys].sort());
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

describe("compareUtf16", () => {
  it("is a total order consistent with sorting", () => {
    const input = ["b", "a", "", "aa", "A", "\u{1F600}", "\uFFFD", "z"];
    const sorted = [...input].sort(compareUtf16);

    for (let i = 1; i < sorted.length; i++) {
      expect(
        compareUtf16(sorted[i - 1] as string, sorted[i] as string),
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
      expect(Math.sign(compareUtf16(a, b))).toBe(
        -Math.sign(compareUtf16(b, a)),
      );
    }
  });

  it("sorts an astral character below the private use area", () => {
    // This is the one pair a code point comparison gets backwards, and the
    // reason this function exists as something other than a bare "<".
    expect(compareUtf16("\u{1F600}", "\uE000")).toBeLessThan(0);
    expect(compareUtf16("\u{1F600}", "\uFFFD")).toBeLessThan(0);
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

  it("emits object keys in UTF-16 code unit order", () => {
    for (let seed = 0; seed < ITERATIONS; seed++) {
      const canonical = canonicalize(randomJson(makeRng(seed), 3));

      for (const keys of objectKeyOrders(canonical)) {
        for (let i = 1; i < keys.length; i++) {
          expect(
            compareUtf16(keys[i - 1] as string, keys[i] as string),
          ).toBeLessThan(0);
        }
      }
    }
  });

  it("escapes nothing that RFC 8785 leaves literal", () => {
    // Two canonicalizers that disagree on which form to use still parse each
    // other's output, so nothing but a byte comparison catches this. Section
    // 3.2.2.2 admits a six-character escape for exactly one reason: a C0
    // control that has no two-character shorthand.
    const shortForm = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

    for (let seed = 0; seed < ITERATIONS; seed++) {
      const canonical = canonicalize(randomJson(makeRng(seed), 3));

      for (const match of canonical.matchAll(/\\u([0-9a-f]{4})/g)) {
        const code = Number.parseInt(match[1] as string, 16);

        expect(shortForm.has(code)).toBe(false);
        expect(code).toBeLessThan(0x20);
      }
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

/**
 * Deterministic 32-bit PRNG, so a failing property test is reproducible.
 *
 * This is mulberry32 rather than the xorshift it replaced. Xorshift seeded
 * from a small counter does not mix on its first output: across the 300
 * seeds this suite uses, the first draw always landed in [0.3125, 0.375),
 * so `randomJson` picked the same branch every time and the whole property
 * suite generated nothing but integers. A generator whose first draw is
 * degenerate is worse than no generator, because the tests still pass.
 */
function makeRng(seed: number): () => number {
  let state = (seed + 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * The character pool the generators draw from. It leans on the characters
 * that have historically broken canonicalizers: the ones that trigger an
 * escape, the ones a JSON library escapes when it should not, non-ASCII, and
 * characters on both sides of the surrogate range to exercise the ordering.
 *
 * All five short-form controls are here, backspace and form feed included.
 * Leaving those two out is what let them go unnoticed: they are the only
 * escapes the protocol's own payloads never produce, so no generator that
 * skips them can tell a short form from a long one. The same argument covers
 * "<", ">", "&", U+2028 and U+2029, which must come out literal.
 */
const CHARS = Array.from(
  'ab-_ AZ09"\\' +
    "\b\f\n\r\t\v\u0000\u001f\u007f" +
    "<>&/" +
    "\u00e9\u4e2d\ud7ff\ue000\uffff\ufffd" +
    "\u{10000}\u{1f600}\u2028\u2029",
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

/**
 * Recover each object's key order from canonical JSON text.
 *
 * The order has to be read out of the bytes rather than out of
 * `JSON.parse`, because a JavaScript object does not preserve the order of
 * keys that look like array indices: parsing `{"9":1,"a":2,"1":3}` yields
 * `1`, `9`, `a`. That is a property of the language's objects, not of the
 * canonicalizer, and checking through it would report a bug that is not
 * there while hiding one that is.
 */
function objectKeyOrders(text: string): string[][] {
  const orders: string[][] = [];
  let at = 0;

  function parseString(): string {
    at++; // Opening quote.
    let out = "";

    while (at < text.length) {
      const char = text[at] as string;

      if (char === "\\") {
        const escape = text[at + 1] as string;
        if (escape === "u") {
          out += String.fromCharCode(
            Number.parseInt(text.slice(at + 2, at + 6), 16),
          );
          at += 6;
        } else {
          out += UNESCAPE[escape] ?? escape;
          at += 2;
        }
        continue;
      }

      at++;
      if (char === '"') return out;
      out += char;
    }

    throw new Error("unterminated string in canonical output");
  }

  function parseValue(): void {
    const char = text[at] as string;

    if (char === "{") {
      at++;
      const keys: string[] = [];
      orders.push(keys);

      while (text[at] !== "}") {
        keys.push(parseString());
        at++; // Colon.
        parseValue();
        if (text[at] === ",") at++;
      }
      at++;
      return;
    }

    if (char === "[") {
      at++;
      while (text[at] !== "]") {
        parseValue();
        if (text[at] === ",") at++;
      }
      at++;
      return;
    }

    if (char === '"') {
      parseString();
      return;
    }

    // A literal: number, true, false, or null.
    while (at < text.length && !",}]".includes(text[at] as string)) at++;
  }

  parseValue();
  return orders;
}

const UNESCAPE: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};
