import { describe, it, expect } from "vitest";
import {
  parseDecimalSat,
  requireBoundedAmount,
  resolveAmountSat,
} from "./amountSafety.js";

describe("resolveAmountSat", () => {
  it("takes the invoice amount when there is no stated price", () => {
    expect(resolveAmountSat(0, "lnbc1000n1fake")).toBe(100);
  });

  it("takes the stated price when there is no invoice", () => {
    expect(resolveAmountSat(250, "")).toBe(250);
  });

  it("takes the larger of the two when they disagree", () => {
    // The wallet pays what the invoice says, so the policy has to bound at
    // least that. A stated price above it is suspicious, but asserting on
    // the larger number never asserts on less than will be spent.
    expect(resolveAmountSat(500, "lnbc1000n1fake")).toBe(500);
    expect(resolveAmountSat(50, "lnbc1000n1fake")).toBe(100);
  });

  it("returns null for an invoice whose amount will not decode", () => {
    expect(resolveAmountSat(500, "xyz2500u1nonsense")).toBeNull();
  });

  it("returns zero for a genuinely amountless invoice", () => {
    expect(resolveAmountSat(0, "lnbc1fake")).toBe(0);
  });

  it("ignores a nonsensical stated price", () => {
    expect(resolveAmountSat(Number.NaN, "lnbc1000n1fake")).toBe(100);
    expect(resolveAmountSat(-5, "lnbc1000n1fake")).toBe(100);
  });
});

describe("requireBoundedAmount", () => {
  it("passes a positive amount through", () => {
    expect(requireBoundedAmount(100, "ctx")).toBe(100);
  });

  it("refuses an amount that could not be decoded", () => {
    expect(() => requireBoundedAmount(null, "L402 challenge")).toThrow(
      /could not be decoded/,
    );
  });

  it("refuses an amountless invoice", () => {
    // Passing zero to the budget policy as a free payment would let the
    // seller name its price after the fact.
    expect(() => requireBoundedAmount(0, "mpp charge")).toThrow(
      /zero-amount invoice/,
    );
    expect(() => requireBoundedAmount(-1, "mpp charge")).toThrow(
      /zero-amount invoice/,
    );
  });

  it("names the protocol in the message", () => {
    expect(() => requireBoundedAmount(null, "mpp session deposit")).toThrow(
      /^mpp session deposit:/,
    );
  });
});

describe("parseDecimalSat", () => {
  it("parses the decimal strings the protocol uses for amounts", () => {
    expect(parseDecimalSat("100")).toBe(100);
    expect(parseDecimalSat("0")).toBe(0);
    expect(parseDecimalSat(" 300 ")).toBe(300);
  });

  it("returns undefined rather than guessing at a bad value", () => {
    // The invoice is the authoritative statement of what will be spent, so
    // an unusable quote falls back to it instead of to a fabricated number.
    expect(parseDecimalSat(undefined)).toBeUndefined();
    expect(parseDecimalSat("")).toBeUndefined();
    expect(parseDecimalSat("1e3")).toBeUndefined();
    expect(parseDecimalSat("-5")).toBeUndefined();
    expect(parseDecimalSat("1.5")).toBeUndefined();
    expect(parseDecimalSat("lots")).toBeUndefined();
  });

  it("returns undefined for a value beyond exact integer range", () => {
    expect(parseDecimalSat("9007199254740993")).toBeUndefined();
  });
});
