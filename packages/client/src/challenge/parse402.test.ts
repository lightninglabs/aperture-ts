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
    expect(challenge.amountSat).toBe(5);
    expect(challenge.macaroon).toBe("AQIDBA==");
    expect(challenge.invoice).toBe("lnbc100n1...");
  });

  it("throws for non-402 response", async () => {
    const response = new Response("OK", { status: 200 });
    await expect(parse402Response(response)).rejects.toThrow("Expected 402");
  });
});
