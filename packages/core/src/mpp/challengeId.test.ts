import { describe, it, expect, beforeAll } from "vitest";
import {
  buildChallengeHmacInput,
  computeChallengeId,
  verifyChallengeId,
} from "./challengeId.js";
import type { ChallengeParams } from "./types.js";
import { fromHex, loadGoVectors, type ChallengeIdVector } from "./goVectors.js";
import { createHmac } from "node:crypto";

let vectors: ChallengeIdVector[];
let secret: Uint8Array;

beforeAll(async () => {
  const loaded = await loadGoVectors();
  vectors = loaded.challengeIds;
  secret = fromHex(loaded.hmacSecretHex);
});

/** The parameters a vector binds, with the computed id left out. */
function toParams(v: ChallengeIdVector): ChallengeParams {
  return { ...v.params, id: "" };
}

describe("challenge id against the Go vector file", () => {
  it("loads a non-trivial vector set", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it("reproduces the pipe-delimited HMAC input", () => {
    for (const v of vectors) {
      expect(buildChallengeHmacInput(toParams(v))).toBe(v.hmacInput);
    }
  });

  it("reproduces every challenge id", async () => {
    for (const v of vectors) {
      expect(await computeChallengeId(secret, toParams(v))).toBe(v.params.id);
    }
  });

  it("verifies every challenge id the reference issued", async () => {
    for (const v of vectors) {
      expect(
        await verifyChallengeId(secret, toParams(v), v.params.id),
      ).toBe(true);
    }
  });

  it("carries the reference's own delimiter ambiguity", async () => {
    // The seven slots are joined with "|" and the realm and method are free
    // text, so two different challenges can produce one HMAC input. The
    // vector file names the pair, which means the reference knows and has
    // decided to live with it. Reproducing it is what interoperating means
    // here, and pinning it is what keeps a future divergence visible.
    const colliding = vectors.filter(
      (v) => v.hmacInput === "a|b|lightning|charge|cQ|||",
    );

    expect(colliding).toHaveLength(2);
    expect(colliding[0]?.params.realm).not.toBe(colliding[1]?.params.realm);
    expect(colliding[0]?.params.id).toBe(colliding[1]?.params.id);
  });
});

describe("challenge id key handling", () => {
  // Node's HMAC accepts key lengths that Web Crypto refuses, which makes it
  // an independent check on the two cases this module handles specially.
  // The Go vector file covers neither, so these stand on the HMAC spec
  // rather than on a peer's output.
  const params: ChallengeParams = {
    id: "",
    realm: "api.example.com",
    method: "lightning",
    intent: "charge",
    request: "eyJhbW91bnQiOiIxMDAifQ",
  };

  function referenceId(key: Uint8Array): string {
    return createHmac("sha256", key)
      .update(buildChallengeHmacInput(params))
      .digest("base64url");
  }

  it("matches a plain HMAC for an ordinary secret", async () => {
    const key = new TextEncoder().encode("test-server-secret-key-32-bytes!");
    expect(await computeChallengeId(key, params)).toBe(referenceId(key));
  });

  it("matches a plain HMAC for a secret past the block size", async () => {
    // A key longer than the 64-byte block is hashed down first, so getting
    // this wrong is silent rather than fatal.
    const key = new TextEncoder().encode("k".repeat(100));
    expect(key.length).toBeGreaterThan(64);
    expect(await computeChallengeId(key, params)).toBe(referenceId(key));
  });

  it("matches a plain HMAC for an empty secret", async () => {
    // Web Crypto refuses a zero-length HMAC key outright, so this module
    // substitutes a single zero byte. HMAC pads any key shorter than the
    // block with zeros, which is why the substitution produces the same tag
    // the empty key would, and this is the check on that reasoning.
    expect(await computeChallengeId("", params)).toBe(
      referenceId(new Uint8Array(0)),
    );
  });
});

describe("challenge id binding", () => {
  const secret = "test-server-secret-key-32-bytes!";
  const base: ChallengeParams = {
    id: "",
    realm: "api.example.com",
    method: "lightning",
    intent: "charge",
    request: "eyJhbW91bnQiOiIxMDAifQ",
    expires: "2026-03-15T12:05:00Z",
    digest: "sha-256=:abc:",
    opaque: "eyJvcmRlciI6IjEyMyJ9",
  };

  const mutations: Array<[string, Partial<ChallengeParams>]> = [
    ["realm", { realm: "other.com" }],
    ["method", { method: "other" }],
    ["intent", { intent: "session" }],
    ["request", { request: "eyJhbW91bnQiOiIyMDAifQ" }],
    ["expires", { expires: "2026-03-16T12:05:00Z" }],
    ["digest", { digest: "sha-256=:xyz:" }],
    ["opaque", { opaque: "eyJvcmRlciI6IjQ1NiJ9" }],
    ["expires removed", { expires: undefined }],
    ["digest removed", { digest: undefined }],
    ["opaque removed", { opaque: undefined }],
  ];

  it.each(mutations)("changing %s changes the id", async (_name, patch) => {
    const original = await computeChallengeId(secret, base);
    const mutated = await computeChallengeId(secret, { ...base, ...patch });

    expect(mutated).not.toBe(original);
    expect(
      await verifyChallengeId(secret, { ...base, ...patch }, original),
    ).toBe(false);
  });

  it("leaves description outside the binding", async () => {
    // The reference implementation's seven slots have no room for
    // description, which is the one parameter a server may vary freely.
    const withDescription = { ...base, description: "Weather report" };
    expect(await computeChallengeId(secret, withDescription)).toBe(
      await computeChallengeId(secret, base),
    );
  });

  it("gives every present-or-absent combination a distinct id", async () => {
    const seen = new Map<string, string>();

    for (const expires of ["", "2026-01-01T00:00:00Z"]) {
      for (const digest of ["", "sha-256=:abc:"]) {
        for (const opaque of ["", "eyJ0ZXN0IjoiMSJ9"]) {
          const name = `${expires}|${digest}|${opaque}`;
          const id = await computeChallengeId(secret, {
            ...base,
            expires: expires || undefined,
            digest: digest || undefined,
            opaque: opaque || undefined,
          });

          expect(seen.get(id)).toBeUndefined();
          seen.set(id, name);
        }
      }
    }

    expect(seen.size).toBe(8);
  });

  it("rejects an id computed under a different secret", async () => {
    const id = await computeChallengeId(secret, base);
    expect(
      await verifyChallengeId("different-secret-key-32-bytes!!", base, id),
    ).toBe(false);
  });

  it("rejects a truncated id", async () => {
    const id = await computeChallengeId(secret, base);
    expect(await verifyChallengeId(secret, base, id.slice(0, -1))).toBe(false);
    expect(await verifyChallengeId(secret, base, "")).toBe(false);
  });

  it("emits an unpadded base64url id", async () => {
    const id = await computeChallengeId(secret, base);
    expect(id).not.toContain("=");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 HMAC-SHA256 bytes encode to 43 unpadded base64url characters.
    expect(id).toHaveLength(43);
  });

  it("accepts a raw byte secret and a text secret interchangeably", async () => {
    const bytes = new TextEncoder().encode(secret);
    expect(await computeChallengeId(bytes, base)).toBe(
      await computeChallengeId(secret, base),
    );
  });
});
