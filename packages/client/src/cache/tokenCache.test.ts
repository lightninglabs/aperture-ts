import { describe, it, expect } from "vitest";
import { TokenCache } from "./tokenCache.js";

describe("TokenCache", () => {
  it("stores and retrieves tokens", () => {
    const cache = new TokenCache();
    const token = {
      macaroonB64: "AQIDBA==",
      preimageHex: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    cache.put("key1", token);
    expect(cache.get("key1")).toEqual(token);
  });

  it("returns null for missing key", () => {
    const cache = new TokenCache();
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("evicts expired tokens", () => {
    const cache = new TokenCache();
    const expired = {
      macaroonB64: "AQIDBA==",
      preimageHex: "a".repeat(64),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };

    cache.put("expired", expired);
    expect(cache.get("expired")).toBeNull();
  });

  it("treats a garbage expiry as expired", () => {
    const cache = new TokenCache();
    cache.put("key", {
      macaroonB64: "AQIDBA==",
      preimageHex: "ab".repeat(32),
      expiresAt: "not-a-date",
    });
    // An unparseable expiry must not mint an immortal bearer credential.
    expect(cache.get("key")).toBeNull();
  });

  it("cacheKey combines origin+routeId+method", () => {
    const key = TokenCache.cacheKey(
      "https://api.example.com:8404",
      "search",
      "POST",
    );
    expect(key).toBe("https://api.example.com:8404|search|POST");
  });
});
