import { describe, it, expect } from "vitest";
import { parse402Response } from "./parse402.js";

describe("parse402Response", () => {
  it("parses JSON body challenge", async () => {
    const response = new Response(
      JSON.stringify({
        error: "payment_required",
        challenge_id: "ch_abc",
        route_id: "search",
        amount_sat: 10,
        invoice: "lnbc100n1...",
        macaroon: "AQIDBA==",
        expires_at: "2026-12-31T00:00:00Z",
      }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    );

    const challenge = await parse402Response(response);
    expect(challenge.challengeId).toBe("ch_abc");
    expect(challenge.routeId).toBe("search");
    expect(challenge.amountSat).toBe(10);
    expect(challenge.invoice).toBe("lnbc100n1...");
    expect(challenge.macaroon).toBe("AQIDBA==");
  });

  it("falls back to headers", async () => {
    const response = new Response("Payment Required", {
      status: 402,
      headers: {
        "Content-Type": "text/plain",
        "WWW-Authenticate": 'L402 macaroon="AQIDBA==", invoice="lnbc100n1..."',
        "X-Aperture-Challenge-Id": "ch_xyz",
        "X-Aperture-Route-Id": "api",
        "X-Aperture-Price-Sat": "5",
      },
    });

    const challenge = await parse402Response(response);
    expect(challenge.challengeId).toBe("ch_xyz");
    expect(challenge.routeId).toBe("api");
    // The header states 5 sat, but the invoice encodes 100 nano-BTC = 10
    // sat, which the wallet will actually pay; the policy asserts on the
    // larger of the two.
    expect(challenge.amountSat).toBe(10);
    expect(challenge.macaroon).toBe("AQIDBA==");
    expect(challenge.invoice).toBe("lnbc100n1...");
  });

  it("decodes the amount from the invoice for Go aperture challenges", async () => {
    // The Go aperture proxy sends only the WWW-Authenticate header: no
    // JSON body and no X-Aperture-Price-Sat header. The amount must come
    // from the BOLT11 invoice itself (1500 nano-BTC = 150 sat).
    const response = new Response("payment required", {
      status: 402,
      headers: {
        "Content-Type": "text/plain",
        "WWW-Authenticate":
          'L402 macaroon="AQIDBA==", invoice="lnbc1500n1pvjluezcqzys"',
      },
    });

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBe(150);
    expect(challenge.invoice).toBe("lnbc1500n1pvjluezcqzys");
    expect(challenge.macaroon).toBe("AQIDBA==");
  });

  it("decodes the amount from the invoice when the JSON body omits it", async () => {
    const response = new Response(
      JSON.stringify({
        error: "payment_required",
        challenge_id: "ch_abc",
        invoice: "lnbc10n1pvjluezcqzys",
        macaroon: "AQIDBA==",
      }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    );

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBe(1);
  });

  it("leaves the amount at 0 for zero-amount invoices", async () => {
    const response = new Response("payment required", {
      status: 402,
      headers: {
        "Content-Type": "text/plain",
        "WWW-Authenticate":
          'L402 macaroon="AQIDBA==", invoice="lnbc1pvjluezcqzys"',
      },
    });

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBe(0);
  });

  it("asserts on the larger of the stated price and the invoice amount", async () => {
    // The seller states 10 sat but the invoice encodes 150 sat. The wallet
    // pays the invoice, so the policy must assert on at least 150 sat.
    const response = new Response(
      JSON.stringify({
        error: "payment_required",
        challenge_id: "ch_abc",
        amount_sat: 10,
        invoice: "lnbc1500n1pvjluezcqzys",
        macaroon: "AQIDBA==",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBe(150);
  });

  it("prefers a stated price larger than the invoice amount", async () => {
    // The seller states 500 sat over a 150 sat invoice; max() keeps the
    // larger bound.
    const response = new Response(
      JSON.stringify({
        error: "payment_required",
        challenge_id: "ch_abc",
        amount_sat: 500,
        invoice: "lnbc1500n1pvjluezcqzys",
        macaroon: "AQIDBA==",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBe(500);
  });

  it("returns a null amount when the invoice cannot be decoded", async () => {
    // An unknown "lntbs" prefix used to fail open to 0; the stated price
    // must not paper over an undecodable invoice, so the amount stays null
    // for the caller to refuse.
    const response = new Response(
      JSON.stringify({
        error: "payment_required",
        challenge_id: "ch_abc",
        amount_sat: 10,
        invoice: "lnxyz2500u1pvjluezcqzys",
        macaroon: "AQIDBA==",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );

    const challenge = await parse402Response(response);
    expect(challenge.amountSat).toBeNull();
  });

  it("throws for non-402 response", async () => {
    const response = new Response("OK", { status: 200 });
    await expect(parse402Response(response)).rejects.toThrow("Expected 402");
  });
});
