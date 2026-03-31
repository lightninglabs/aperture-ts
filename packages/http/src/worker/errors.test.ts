import { describe, it, expect } from "vitest";
import { ApertureError, errorToResponse } from "./errors.js";

describe("ApertureError + errorToResponse", () => {
  it("payment_required → 402", () => {
    const err = new ApertureError("payment_required");
    const res = errorToResponse(err);
    expect(res.status).toBe(402);
  });

  it("route_not_found → 404", () => {
    const res = errorToResponse(new ApertureError("route_not_found"));
    expect(res.status).toBe(404);
  });

  it("policy_denied → 403", () => {
    const res = errorToResponse(new ApertureError("policy_denied"));
    expect(res.status).toBe(403);
  });

  it("invoice_backend_unavailable → 503", () => {
    const res = errorToResponse(new ApertureError("invoice_backend_unavailable"));
    expect(res.status).toBe(503);
  });

  it("internal_error → 500", () => {
    const res = errorToResponse(new ApertureError("internal_error"));
    expect(res.status).toBe(500);
  });

  it("response body contains error code", async () => {
    const err = new ApertureError("macaroon_invalid", "bad mac");
    const res = errorToResponse(err);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toBe("macaroon_invalid");
    expect(body.message).toBe("bad mac");
  });
});
