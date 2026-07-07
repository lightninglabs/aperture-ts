import { describe, it, expect } from "vitest";
import { bolt11AmountSat } from "./bolt11Amount.js";

// The data part after the bech32 separator never matters for amount
// decoding, so a short charset-valid stand-in is enough.
const DATA = "pvjluezcqzysxq";

describe("bolt11AmountSat", () => {
  it("decodes nano-BTC amounts", () => {
    // 10 nano-BTC = 1e-8 BTC = 1 sat.
    expect(bolt11AmountSat(`lnbc10n1${DATA}`)).toBe(1);
    // 1500 nano-BTC = 150 sat.
    expect(bolt11AmountSat(`lnbc1500n1${DATA}`)).toBe(150);
  });

  it("decodes micro-BTC amounts", () => {
    // 2500 micro-BTC = 250_000 sat.
    expect(bolt11AmountSat(`lnbc2500u1${DATA}`)).toBe(250_000);
  });

  it("decodes milli-BTC amounts", () => {
    // 25 milli-BTC = 2_500_000 sat.
    expect(bolt11AmountSat(`lnbc25m1${DATA}`)).toBe(2_500_000);
  });

  it("decodes whole-BTC amounts with no multiplier", () => {
    // "lnbc1" is the human-readable part (1 BTC); the second "1" is the
    // bech32 separator.
    expect(bolt11AmountSat(`lnbc11${DATA}`)).toBe(100_000_000);
    expect(bolt11AmountSat(`lnbc21${DATA}`)).toBe(200_000_000);
  });

  it("rounds sub-satoshi pico-BTC amounts up", () => {
    // 2500 pico-BTC = 2.5e-9 BTC = 0.25 sat, which ceils to 1 sat.
    expect(bolt11AmountSat(`lnbc2500p1${DATA}`)).toBe(1);
    // 10_000 pico-BTC is exactly 1 sat, so no rounding occurs.
    expect(bolt11AmountSat(`lnbc10000p1${DATA}`)).toBe(1);
  });

  it("handles the regtest prefix despite sharing a prefix with mainnet", () => {
    // "lnbcrt" must not parse as "lnbc" + "rt...": the amount here is
    // 500 nano-BTC = 50 sat.
    expect(bolt11AmountSat(`lnbcrt500n1${DATA}`)).toBe(50);
  });

  it("handles testnet and simnet prefixes", () => {
    expect(bolt11AmountSat(`lntb100n1${DATA}`)).toBe(10);
    expect(bolt11AmountSat(`lnsb100n1${DATA}`)).toBe(10);
  });

  it("handles the signet prefix", () => {
    // "lntbs" (signet) must not parse as "lntb" (testnet) followed by an
    // "s..." amount slot: 2500 micro-BTC = 250_000 sat.
    expect(bolt11AmountSat(`lntbs2500u1${DATA}`)).toBe(250_000);
    expect(bolt11AmountSat(`lntbs500n1${DATA}`)).toBe(50);
  });

  it("returns 0 for zero-amount invoices", () => {
    // No digits between the prefix and the separator.
    expect(bolt11AmountSat(`lnbc1${DATA}`)).toBe(0);
    expect(bolt11AmountSat(`lnbcrt1${DATA}`)).toBe(0);
  });

  it("returns null for strings that are not BOLT11 invoices", () => {
    // A null result signals an unbounded outflow the caller must refuse to
    // pay, distinct from the 0 of a genuine zero-amount invoice.
    expect(bolt11AmountSat("")).toBeNull();
    expect(bolt11AmountSat("not-an-invoice")).toBeNull();
    expect(bolt11AmountSat("lightning:please")).toBeNull();
  });

  it("returns null for a known prefix with a malformed amount slot", () => {
    expect(bolt11AmountSat(`lnbc12x34n1${DATA}`)).toBeNull();
  });

  it("returns null for an unknown currency prefix", () => {
    // An unknown HRP prefix must not fail open to 0: the wallet would still
    // pay the invoice's real amount.
    expect(bolt11AmountSat(`lnxyz2500u1${DATA}`)).toBeNull();
  });

  it("accepts uppercase invoices", () => {
    // BOLT11 permits an all-uppercase encoding.
    expect(bolt11AmountSat(`LNBC1500N1${DATA.toUpperCase()}`)).toBe(150);
  });
});
