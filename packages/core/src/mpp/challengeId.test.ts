import { describe, it, expect, beforeAll } from "vitest";
import {
  buildChallengeHmacInput,
  computeChallengeId,
  verifyChallengeId,
} from "./challengeId.js";
import type { ChallengeParams } from "./types.js";
import { loadGoVectors, type ChallengeIdVector } from "./goVectors.js";

let vectors: ChallengeIdVector[];

beforeAll(async () => {
  vectors = (await loadGoVectors()).challengeId;
});

function toParams(v: ChallengeIdVector): ChallengeParams {
  return {
    id: "",
    realm: v.realm,
    method: v.method,
    intent: v.intent,
    request: v.request,
    expires: v.expires || undefined,
    digest: v.digest || undefined,
    opaque: v.opaque || undefined,
  };
}

describe("challenge id against Go reference vectors", () => {
  it("reproduces the pipe-delimited HMAC input", () => {
    for (const v of vectors) {
      expect(buildChallengeHmacInput(toParams(v))).toBe(v.hmacInput);
    }
  });

  it("reproduces every challenge id", async () => {
    for (const v of vectors) {
      expect(await computeChallengeId(v.secret, toParams(v))).toBe(v.id);
    }
  });

  it("verifies every challenge id the reference issued", async () => {
    for (const v of vectors) {
      expect(await verifyChallengeId(v.secret, toParams(v), v.id)).toBe(true);
    }
  });

  it("covers a secret longer than the HMAC block size", async () => {
    const long = vectors.find((v) => v.name === "long secret");
    expect(long?.secret.length).toBeGreaterThan(64);
    expect(await computeChallengeId(long!.secret, toParams(long!))).toBe(
      long!.id,
    );
  });

  it("covers an empty secret, which Web Crypto refuses to import", async () => {
    // HMAC pads any key shorter than the block size with zeros, so an empty
    // key and a single zero byte produce the same tag. Web Crypto rejects
    // the former outright, and the reference implementation accepts it.
    const empty = vectors.find((v) => v.name === "empty secret");
    expect(empty?.secret).toBe("");
    expect(await computeChallengeId("", toParams(empty!))).toBe(empty!.id);
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
