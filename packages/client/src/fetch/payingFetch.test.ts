import { describe, it, expect, vi, afterEach } from "vitest";
import { paymentHashFromPreimage } from "@lightninglabs/aperture-core/util";
import { createPayingFetch } from "./payingFetch.js";
import { MockInvoicePayer } from "../payer/interface.js";
import type { CachedToken, TokenStore } from "../cache/tokenCache.js";
import type { ClientReceipt } from "../cache/receiptCache.js";

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

  it("keys cached tokens by origin, not bare hostname", async () => {
    // Two proxies on different ports of the same host mint unrelated
    // tokens: a token paid for on :8404 must not be attached to a request
    // against :8402.
    const seenAuth: Array<string | null> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      seenAuth.push(req.headers.get("Authorization"));
      if (req.headers.get("Authorization")) {
        return new Response("ok", { status: 200 });
      }
      return challengeResponse();
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({ payer: newPayer() });

    // First call pays and caches under http://api.example.com:8404.
    await payingFetch("http://api.example.com:8404/infer");
    // Second call to the same origin rides the cached token.
    await payingFetch("http://api.example.com:8404/infer");
    // A different port on the same host must start unauthenticated.
    await payingFetch("http://api.example.com:8402/infer");

    // Call 1: no auth (fresh), call 2: paid retry with auth, call 3: cache
    // hit for the same origin, call 4: no auth (different origin), call 5:
    // its own paid retry.
    expect(seenAuth[0]).toBeNull();
    expect(seenAuth[1]).not.toBeNull();
    expect(seenAuth[2]).not.toBeNull();
    expect(seenAuth[3]).toBeNull();
    expect(seenAuth[4]).not.toBeNull();
  });

  it("supports asynchronous token stores", async () => {
    // A durable (file- or db-backed) store returns promises; the paying
    // fetch must await it on both the read and write side.
    const backing = new Map<string, CachedToken>();
    const asyncStore: TokenStore = {
      async get(key) {
        return backing.get(key) ?? null;
      },
      async put(key, token) {
        backing.set(key, token);
      },
    };

    let calls = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const req = input as Request;
      calls += 1;
      if (req.headers.get("Authorization")) {
        return new Response("ok", { status: 200 });
      }
      return challengeResponse();
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({
      payer: newPayer(),
      tokenCache: asyncStore,
    });

    await payingFetch("https://api.example.com/infer");
    expect(backing.size).toBe(1);

    // The second call must hit the async cache: one fetch, no 402.
    calls = 0;
    const response = await payingFetch("https://api.example.com/infer");
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
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

describe("payingFetch receipts", () => {
  it("records a self-verifying receipt before the paid retry runs", async () => {
    const receipts: ClientReceipt[] = [];
    const receiptStore = {
      async store(receipt: ClientReceipt) {
        receipts.push(receipt);
      },
    };

    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return challengeResponse();
      }
      // The paid retry dies on the network. Money already moved, so the
      // receipt must survive this.
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({
      payer: newPayer(),
      receiptCache: receiptStore,
    });

    await expect(
      payingFetch("https://api.example.com/infer"),
    ).rejects.toThrow(/fetch failed/);

    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;

    // The payment hash is derived from the preimage, so the receipt is a
    // self-contained proof of payment.
    expect(receipt.paymentHash).toBe(
      await paymentHashFromPreimage(PREIMAGE),
    );
    expect(receipt.preimageHex).toBe(PREIMAGE);
    expect(receipt.amountSat).toBe(10);
    expect(receipt.paidSat).toBe(10);
    expect(receipt.invoice).toBe("lnbc100n1fake");
    expect(receipt.url).toBe("https://api.example.com/infer");
  });
});

describe("payingFetch post-payment durability", () => {
  it("persists the token before a failing paid retry", async () => {
    const backing = new Map<string, CachedToken>();
    const asyncStore: TokenStore = {
      async get(key) {
        return backing.get(key) ?? null;
      },
      async put(key, token) {
        backing.set(key, token);
      },
    };

    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return challengeResponse();
      }
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fakeFetch);

    const payingFetch = createPayingFetch({
      payer: newPayer(),
      tokenCache: asyncStore,
    });

    await expect(
      payingFetch("https://api.example.com/infer"),
    ).rejects.toThrow(/fetch failed/);

    // The paid credential survived the failed retry: the next process (or
    // call) can ride it instead of re-purchasing.
    expect(backing.size).toBe(1);
    const token = [...backing.values()][0]!;
    expect(token.preimageHex).toBe(PREIMAGE);
  });

  it("still serves the paid response when the stores fail", async () => {
    // Money has already moved once payInvoice settles; a durable-store
    // error must not abort the request the user paid for.
    const receipts: ClientReceipt[] = [];
    const failingTokenStore: TokenStore = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("disk full");
      },
    };

    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return challengeResponse();
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const payingFetch = createPayingFetch({
        payer: newPayer(),
        tokenCache: failingTokenStore,
        receiptCache: {
          async store(receipt: ClientReceipt) {
            receipts.push(receipt);
          },
        },
      });

      const response = await payingFetch("https://api.example.com/infer");
      expect(response.status).toBe(200);

      // The receipt write is independent of the failed token write.
      expect(receipts).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("payingFetch malformed preimage", () => {
  it("still records the receipt when the preimage cannot be hashed", async () => {
    // A buggy payer returns a 16-byte preimage. The hash derivation fails,
    // but the spend record must survive with an empty hash, and the paid
    // response must still be served.
    const receipts: ClientReceipt[] = [];
    const payer = new MockInvoicePayer();
    payer.addPreimage("hash", "ab".repeat(16));

    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return challengeResponse();
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const payingFetch = createPayingFetch({
        payer,
        receiptCache: {
          async store(receipt: ClientReceipt) {
            receipts.push(receipt);
          },
        },
      });

      const response = await payingFetch("https://api.example.com/infer");
      expect(response.status).toBe(200);

      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.paymentHash).toBe("");
      expect(receipts[0]!.preimageHex).toBe("ab".repeat(16));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
