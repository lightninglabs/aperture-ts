import { describe, it, expect, vi, afterEach } from "vitest";
import { createPayingFetch } from "./payingFetch.js";
import { MockInvoicePayer } from "../payer/interface.js";

const PREIMAGE = "ab".repeat(32);

/** Build a 402 challenge response in the Aperture JSON-body shape. */
function challengeResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: "payment_required",
      challenge_id: "ch_test",
      route_id: "api",
      amount_sat: 10,
      invoice: "lnbc100n1fake",
      macaroon: "AQIDBA==",
      expires_at: "2099-01-01T00:00:00Z",
      ...overrides,
    }),
    { status: 402, headers: { "Content-Type": "application/json" } },
  );
}

function newPayer(): MockInvoicePayer {
  const payer = new MockInvoicePayer();
  payer.addPreimage("hash", PREIMAGE);
  return payer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("payingFetch retry body handling", () => {
  it("re-sends the original POST body on the paid retry", async () => {
    const payload = JSON.stringify({ prompt: "hello", max_tokens: 42 });
    const seenBodies: string[] = [];
    const seenAuth: Array<string | null> = [];

    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      // Fully consume the body, as a real server (and undici) would.
      seenBodies.push(await req.text());
      seenAuth.push(req.headers.get("Authorization"));

      if (seenBodies.length === 1) {
        return challengeResponse();
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({ payer: newPayer() });
    const response = await payingFetch("https://api.example.com/infer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // The retry must carry the L402 authorization from the paid challenge.
    expect(seenAuth[1]).toBe(`L402 AQIDBA==:${PREIMAGE}`);

    // The retry body must be byte-identical to the original payload, even
    // though the first fetch already consumed the request body stream.
    expect(seenBodies[0]).toBe(payload);
    expect(seenBodies[1]).toBe(payload);
  });

  it("handles GET requests without a body across the retry", async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      calls += 1;
      if (calls === 1) {
        return challengeResponse();
      }
      expect(req.method).toBe("GET");
      expect(req.body).toBeNull();
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({ payer: newPayer() });
    const response = await payingFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("payingFetch amount safety", () => {
  it("refuses to pay when the invoice amount cannot be decoded", async () => {
    // The stated amount_sat is 0 and the invoice uses an unknown prefix, so
    // the resolved amount is null. The wallet would still pay the invoice's
    // real amount, so payingFetch must throw before spending.
    const payInvoice = vi.fn();
    const fakeFetch = vi.fn(async () =>
      challengeResponse({ amount_sat: 0, invoice: "lnxyz2500u1fake" }),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const payer = newPayer();
    payer.payInvoice = payInvoice;

    const payingFetch = createPayingFetch({ payer });
    await expect(
      payingFetch("https://api.example.com/infer"),
    ).rejects.toThrow(/could not be decoded/);

    // Only the first fetch ran; no payment was attempted.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it("refuses to pay a zero-amount invoice", async () => {
    // A genuine zero-amount invoice (no amount in the HRP) with no stated
    // price cannot bound the outflow, so payingFetch refuses by default.
    const payInvoice = vi.fn();
    const fakeFetch = vi.fn(async () =>
      challengeResponse({ amount_sat: 0, invoice: "lnbc1fake" }),
    );
    vi.stubGlobal("fetch", fakeFetch);

    const payer = newPayer();
    payer.payInvoice = payInvoice;

    const payingFetch = createPayingFetch({ payer });
    await expect(
      payingFetch("https://api.example.com/infer"),
    ).rejects.toThrow(/zero-amount invoice/);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it("does not pay when the caller aborts before payment", async () => {
    // The signal is already aborted by the time the challenge is parsed, so
    // the wallet must not spend on the abandoned request.
    const controller = new AbortController();
    const payInvoice = vi.fn();
    const fakeFetch = vi.fn(async () => {
      // Abort the moment the first fetch resolves, mimicking a caller that
      // cancelled mid-flight.
      controller.abort();
      return challengeResponse();
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payer = newPayer();
    payer.payInvoice = payInvoice;

    const payingFetch = createPayingFetch({ payer });
    await expect(
      payingFetch("https://api.example.com/infer", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);

    expect(payInvoice).not.toHaveBeenCalled();
  });
});
