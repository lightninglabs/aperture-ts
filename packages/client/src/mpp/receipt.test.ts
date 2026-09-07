import { describe, it, expect, vi } from "vitest";
import {
  METHOD_LIGHTNING,
  encodeReceipt,
  type SessionReceipt,
} from "@lightninglabs/aperture-core/mpp";
import { checkReceipt, readReceipt, readRefund } from "./receipt.js";
import { receiptResponse } from "./fixtures.js";

const GOOD: SessionReceipt = {
  status: "success",
  method: METHOD_LIGHTNING,
  timestamp: "2026-03-10T21:00:00Z",
  reference: "bc230847",
  challengeId: "kM9xPqWvT2nJrHsY4aDfEb",
};

describe("readReceipt", () => {
  it("reads a receipt off a response", () => {
    const response = receiptResponse({ reference: "abc123" });
    expect(readReceipt(response)?.reference).toBe("abc123");
  });

  it("returns null when there is no receipt", () => {
    // A bearer request settles nothing, so no receipt is not an error.
    expect(readReceipt(new Response("ok"))).toBeNull();
  });

  it("returns null rather than throwing on a malformed receipt", () => {
    const response = new Response("ok", {
      headers: { "Payment-Receipt": "!!!not base64!!!" },
    });
    expect(readReceipt(response)).toBeNull();
  });

  it("returns null for a receipt missing its required fields", () => {
    const response = new Response("ok", {
      headers: {
        "Payment-Receipt": encodeReceipt({
          status: "success",
        } as never),
      },
    });
    expect(readReceipt(response)).toBeNull();
  });

  it("does not hand back a receipt that says the payment failed", () => {
    // A receipt is the only evidence this client keeps that a payment
    // settled, so one claiming a status the protocol does not define is
    // dropped rather than filed as proof.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response("ok", {
      headers: {
        "Payment-Receipt": encodeReceipt({ ...GOOD, status: "failed" }),
      },
    });

    expect(readReceipt(response)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("checkReceipt", () => {
  it("accepts a receipt that matches what was paid for", () => {
    expect(
      checkReceipt(GOOD, {
        method: METHOD_LIGHTNING,
        challengeId: GOOD.challengeId,
        reference: GOOD.reference,
      }),
    ).toEqual([]);
  });

  it("rejects a status other than success", () => {
    const reasons = checkReceipt({ ...GOOD, status: "pending" }, {});
    expect(reasons.join(" ")).toMatch(/receipt status/);
  });

  it("rejects a receipt that settles a different challenge", () => {
    const reasons = checkReceipt(GOOD, { challengeId: "some-other-id" });
    expect(reasons.join(" ")).toMatch(/settles challenge/);
  });

  it("rejects a receipt that references a different payment", () => {
    const reasons = checkReceipt(GOOD, { reference: "some-other-hash" });
    expect(reasons.join(" ")).toMatch(/receipt references/);
  });

  it("rejects a receipt for a different payment method", () => {
    const reasons = checkReceipt({ ...GOOD, method: "ach" }, {
      method: METHOD_LIGHTNING,
    });
    expect(reasons.join(" ")).toMatch(/receipt method/);
  });

  it("accepts a receipt that omits the optional challenge id", () => {
    // The field is optional in the protocol, so its absence is not a
    // disagreement about anything.
    const { challengeId: _omitted, ...withoutId } = GOOD;
    expect(
      checkReceipt(withoutId, { challengeId: "kM9xPqWvT2nJrHsY4aDfEb" }),
    ).toEqual([]);
  });

  it("reports every disagreement rather than the first", () => {
    const reasons = checkReceipt(
      { ...GOOD, status: "pending", method: "ach" },
      { method: METHOD_LIGHTNING, reference: "elsewhere" },
    );
    expect(reasons).toHaveLength(3);
  });
});

describe("readRefund", () => {
  it("reads the refund a close reports", () => {
    expect(
      readRefund({ ...GOOD, refundSats: 140, refundStatus: "succeeded" }),
    ).toEqual({ refundSats: 140, refundStatus: "succeeded" });
  });

  it("treats an omitted amount alongside a status as zero", () => {
    // A close with nothing left to send back reports skipped and omits the
    // amount, so the amount is zero rather than unknown.
    expect(readRefund({ ...GOOD, refundStatus: "skipped" })).toEqual({
      refundSats: 0,
      refundStatus: "skipped",
    });
  });

  it("returns null for a receipt that is not about a close", () => {
    expect(readRefund(GOOD)).toBeNull();
  });

  it("reports a failed refund as such rather than as zero", () => {
    // A failed refund still owes the client money; conflating it with a
    // skipped one hides that.
    expect(
      readRefund({ ...GOOD, refundSats: 140, refundStatus: "failed" }),
    ).toEqual({ refundSats: 140, refundStatus: "failed" });
  });
});
