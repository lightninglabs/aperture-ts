import { describe, it, expect } from "vitest";
import { buildHttp402Challenge } from "./challenge.js";

describe("buildHttp402Challenge", () => {
  const params = {
    challengeId: "ch_123",
    routeId: "search_api",
    amountSat: 10,
    invoice: "lnbc100n1...",
    macaroonB64: "AQIDBA==",
    expiresAt: "2026-03-30T22:20:00Z",
  };

  it("returns 402 status", () => {
    const response = buildHttp402Challenge(params);
    expect(response.status).toBe(402);
  });

  it("sets WWW-Authenticate header", () => {
    const response = buildHttp402Challenge(params);
    const wwwAuth = response.headers.get("WWW-Authenticate");
    expect(wwwAuth).toContain("L402");
    expect(wwwAuth).toContain(params.macaroonB64);
    expect(wwwAuth).toContain(params.invoice);
  });

  it("sets X-Aperture headers", () => {
    const response = buildHttp402Challenge(params);
    expect(response.headers.get("X-Aperture-Challenge-Id")).toBe("ch_123");
    expect(response.headers.get("X-Aperture-Price-Sat")).toBe("10");
    expect(response.headers.get("X-Aperture-Route-Id")).toBe("search_api");
  });

  it("returns JSON body with challenge details", async () => {
    const response = buildHttp402Challenge(params);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.scheme).toBe("L402");
    expect(body.amount_sat).toBe(10);
    expect(body.invoice).toBe(params.invoice);
    expect(body.macaroon).toBe(params.macaroonB64);
  });
});
