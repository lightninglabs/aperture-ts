import { describe, it, expect, vi, afterEach } from "vitest";
import { CredentialCache } from "./credentialCache.js";

const CREDENTIAL = { authorization: "Payment abc", challengeId: "ch_1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("CredentialCache", () => {
  it("stores and returns a paid credential", () => {
    const cache = new CredentialCache();
    cache.put("k", CREDENTIAL);

    expect(cache.get("k")).toEqual(CREDENTIAL);
  });

  it("returns null for a key it has never seen", () => {
    expect(new CredentialCache().get("missing")).toBeNull();
  });

  it("evicts an expired credential on read", () => {
    const cache = new CredentialCache();
    cache.put("k", { ...CREDENTIAL, expiresAt: "2020-01-01T00:00:00Z" });

    expect(cache.get("k")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("keeps a credential that has not expired yet", () => {
    const cache = new CredentialCache();
    cache.put("k", { ...CREDENTIAL, expiresAt: "2099-01-01T00:00:00Z" });

    expect(cache.get("k")?.authorization).toBe("Payment abc");
  });

  it("treats an unparseable expiry as expired", () => {
    // NaN loses every comparison, which would otherwise make a credential
    // built from garbage immortal.
    const cache = new CredentialCache();
    cache.put("k", { ...CREDENTIAL, expiresAt: "not a timestamp" });

    expect(cache.get("k")).toBeNull();
  });

  it("keeps a credential with no expiry", () => {
    const cache = new CredentialCache();
    cache.put("k", CREDENTIAL);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(cache.get("k")).not.toBeNull();
  });

  it("keys on the full origin, not the bare hostname", () => {
    // A plaintext origin must never share a paid credential with a TLS
    // origin, and two proxies on different ports mint unrelated ones.
    expect(CredentialCache.cacheKey("https://a.example", "/infer", "POST")).toBe(
      "https://a.example|/infer|POST",
    );
    expect(
      CredentialCache.cacheKey("https://a.example:8443", "/infer", "POST"),
    ).not.toBe(CredentialCache.cacheKey("https://a.example", "/infer", "POST"));
    expect(
      CredentialCache.cacheKey("http://a.example", "/infer", "POST"),
    ).not.toBe(CredentialCache.cacheKey("https://a.example", "/infer", "POST"));
  });

  it("drops a credential on request", () => {
    const cache = new CredentialCache();
    cache.put("k", CREDENTIAL);
    cache.delete("k");

    expect(cache.get("k")).toBeNull();
  });
});
