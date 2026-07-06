import { describe, it, expect } from "vitest";
import { attachL402Header, ensureIdempotencyKey } from "./retry.js";

describe("attachL402Header", () => {
  it("sets Authorization header", () => {
    const req = new Request("https://api.example.com/test");
    const updated = attachL402Header(
      req,
      "AQIDBA==",
      "abcd1234".repeat(8),
      null,
    );
    expect(updated.headers.get("Authorization")).toBe(
      `L402 AQIDBA==:${"abcd1234".repeat(8)}`,
    );
  });

  it("preserves the caller's abort signal", () => {
    const controller = new AbortController();
    const req = new Request("https://api.example.com/test", {
      signal: controller.signal,
    });
    const updated = attachL402Header(req, "AQIDBA==", "ab".repeat(32), null);
    controller.abort();
    expect(updated.signal.aborted).toBe(true);
  });

  it("requires the body argument at the type level", () => {
    // The body parameter is required so that a caller cannot silently
    // rebuild a bodyless request with the old three-argument arity. This
    // asserts the compile-time contract; passing too few arguments is a
    // TypeScript error, which the @ts-expect-error below consumes.
    const req = new Request("https://api.example.com/test");
    // @ts-expect-error body is a required argument.
    attachL402Header(req, "AQIDBA==", "ab".repeat(32));
  });
});

describe("ensureIdempotencyKey", () => {
  it("adds key to POST requests", () => {
    const req = new Request("https://api.example.com/test", { method: "POST" });
    const updated = ensureIdempotencyKey(req, null);
    expect(updated.headers.has("Idempotency-Key")).toBe(true);
  });

  it("skips GET requests", () => {
    const req = new Request("https://api.example.com/test");
    const updated = ensureIdempotencyKey(req, null);
    expect(updated.headers.has("Idempotency-Key")).toBe(false);
  });

  it("preserves existing key", () => {
    const req = new Request("https://api.example.com/test", {
      method: "POST",
      headers: { "Idempotency-Key": "my-key" },
    });
    const updated = ensureIdempotencyKey(req, null);
    expect(updated.headers.get("Idempotency-Key")).toBe("my-key");
  });

  it("requires the body argument at the type level", () => {
    // The body parameter is required so external callers cannot silently
    // strip the request body with the old single-argument arity.
    const req = new Request("https://api.example.com/test", { method: "POST" });
    // @ts-expect-error body is a required argument.
    ensureIdempotencyKey(req);
  });
});
