import { describe, it, expect } from "vitest";
import { attachL402Header, ensureIdempotencyKey } from "./retry.js";

describe("attachL402Header", () => {
  it("sets Authorization header", () => {
    const req = new Request("https://api.example.com/test");
    const updated = attachL402Header(req, "AQIDBA==", "abcd1234".repeat(8));
    expect(updated.headers.get("Authorization")).toBe(
      `L402 AQIDBA==:${"abcd1234".repeat(8)}`,
    );
  });
});

describe("ensureIdempotencyKey", () => {
  it("adds key to POST requests", () => {
    const req = new Request("https://api.example.com/test", { method: "POST" });
    const updated = ensureIdempotencyKey(req);
    expect(updated.headers.has("Idempotency-Key")).toBe(true);
  });

  it("skips GET requests", () => {
    const req = new Request("https://api.example.com/test");
    const updated = ensureIdempotencyKey(req);
    expect(updated.headers.has("Idempotency-Key")).toBe(false);
  });

  it("preserves existing key", () => {
    const req = new Request("https://api.example.com/test", {
      method: "POST",
      headers: { "Idempotency-Key": "my-key" },
    });
    const updated = ensureIdempotencyKey(req);
    expect(updated.headers.get("Idempotency-Key")).toBe("my-key");
  });
});
