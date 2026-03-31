import { describe, it, expect } from "vitest";
import { parseL402Authorization } from "./parseAuthorization.js";

describe("parseL402Authorization", () => {
  const validMac = "AQIDBA=="; // Valid base64.
  const validPreimage = "a".repeat(64); // 64 hex chars.

  it("parses valid L402 header", () => {
    const result = parseL402Authorization(`L402 ${validMac}:${validPreimage}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scheme).toBe("L402");
      expect(result.value.macaroonsB64).toEqual([validMac]);
      expect(result.value.preimageHex).toBe(validPreimage);
    }
  });

  it("accepts legacy LSAT scheme", () => {
    const result = parseL402Authorization(`LSAT ${validMac}:${validPreimage}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scheme).toBe("L402");
    }
  });

  it("is case-insensitive for scheme", () => {
    const result = parseL402Authorization(`l402 ${validMac}:${validPreimage}`);
    expect(result.ok).toBe(true);
  });

  it("rejects unsupported scheme", () => {
    const result = parseL402Authorization(`Bearer ${validMac}:${validPreimage}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsupported scheme");
  });

  it("rejects missing scheme", () => {
    const result = parseL402Authorization(`${validMac}:${validPreimage}`);
    expect(result.ok).toBe(false);
  });

  it("rejects missing colon separator", () => {
    const result = parseL402Authorization(`L402 ${validMac}${validPreimage}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("colon");
  });

  it("rejects non-hex preimage", () => {
    const result = parseL402Authorization(`L402 ${validMac}:${"g".repeat(64)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("hex");
  });

  it("rejects short preimage", () => {
    const result = parseL402Authorization(`L402 ${validMac}:${"a".repeat(32)}`);
    expect(result.ok).toBe(false);
  });

  it("rejects oversized header", () => {
    const huge = "L402 " + "A".repeat(5000) + ":" + validPreimage;
    const result = parseL402Authorization(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("too large");
  });

  it("rejects empty credentials", () => {
    const result = parseL402Authorization("L402 ");
    expect(result.ok).toBe(false);
  });
});
