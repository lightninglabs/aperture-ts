/**
 * End-to-end tests for the Payment authentication scheme half of the buyer
 * loop, driven through `createPayingFetch` against a stubbed seller.
 *
 * The assertions that matter most here are about counts: how many times the
 * wallet was asked to pay, and how many times the request was sent. A
 * paying client that returns the right response having paid twice is
 * broken in the expensive direction.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE,
  PROBLEM_LIGHTNING_SESSION_CLOSED,
  PROBLEM_LIGHTNING_SESSION_NOT_FOUND,
  PROBLEM_VERIFICATION_FAILED,
  parseCredential,
  type SessionPayload,
} from "@aperture/core/mpp";
import { createPayingFetch } from "./payingFetch.js";
import { SessionCache } from "../cache/sessionStore.js";
import {
  CredentialCache,
  type CredentialStore,
} from "../cache/credentialCache.js";
import { TokenCache } from "../cache/tokenCache.js";
import { ReceiptCache, type ReceiptStore } from "../cache/receiptCache.js";
import { MockReturnInvoiceMinter } from "../mpp/mockMinter.js";
import {
  ScriptedPayer,
  SessionSeller,
  challengeResponse,
  chargeChallenge,
  hashFor,
  invoiceFor,
  preimageFor,
  receiptResponse,
  sessionChallenge,
} from "../mpp/fixtures.js";

const URL_UNDER_TEST = "https://api.example.com/infer";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Record every request the client sends, with its Authorization header. */
interface Sent {
  url: string;
  authorization: string | null;
  body: string;
}

function stubFetch(
  handler: (sent: Sent, index: number) => Response | Promise<Response>,
): { calls: Sent[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: Sent[] = [];

  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const sent: Sent = {
      url: request.url,
      authorization: request.headers.get("Authorization"),
      body: request.body === null ? "" : await request.text(),
    };
    calls.push(sent);

    return handler(sent, calls.length - 1);
  });

  vi.stubGlobal("fetch", fake);
  return { calls, fetch: fake };
}

/** Decode the session payload out of an Authorization header. */
function sessionPayload(authorization: string | null): SessionPayload {
  if (authorization === null) throw new Error("no Authorization header");
  return parseCredential<SessionPayload>(authorization).payload;
}

function newClient(
  overrides: {
    payer?: ScriptedPayer;
    minter?: MockReturnInvoiceMinter | null;
    sessionStore?: SessionCache;
    credentialCache?: CredentialCache;
    tokenCache?: TokenCache;
    receiptCache?: ReceiptCache;
    intents?: readonly string[];
    buyerPolicy?: { assertAllowed: (input: unknown) => Promise<void> };

    /**
     * Stores that only have to satisfy the interface, so a test can hand
     * the client one that fails. The caches above stay concretely typed,
     * because most tests read back out of them.
     */
    receiptStore?: ReceiptStore;
    credentialStore?: CredentialStore;
  } = {},
) {
  const payer = overrides.payer ?? new ScriptedPayer();
  const minter =
    overrides.minter === null
      ? undefined
      : (overrides.minter ?? new MockReturnInvoiceMinter());
  const sessionStore = overrides.sessionStore ?? new SessionCache();
  const credentialCache = overrides.credentialCache ?? new CredentialCache();
  const tokenCache = overrides.tokenCache ?? new TokenCache();
  const receiptCache = overrides.receiptCache ?? new ReceiptCache();

  const client = createPayingFetch({
    payer,
    receiptCache: overrides.receiptStore ?? receiptCache,
    tokenCache,
    ...(overrides.buyerPolicy === undefined
      ? {}
      : { buyerPolicy: overrides.buyerPolicy as never }),
    mpp: {
      sessionStore,
      credentialCache: overrides.credentialStore ?? credentialCache,
      ...(minter === undefined ? {} : { returnInvoiceMinter: minter }),
      ...(overrides.intents === undefined ? {} : { intents: overrides.intents }),
    },
  });

  return {
    client,
    payer,
    minter,
    sessionStore,
    credentialCache,
    tokenCache,
    receiptCache,
  };
}

describe("charge intent", () => {
  it("pays once and retries once", async () => {
    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(payer.paid).toHaveLength(1);
    expect(calls[1]?.authorization).toMatch(/^Payment /);
  });

  it("sends the preimage in the credential payload", async () => {
    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");
    await client(URL_UNDER_TEST);

    const credential = parseCredential<{ preimage: string }>(
      calls[1]?.authorization as string,
    );
    expect(credential.payload.preimage).toBe(preimageFor("charge"));
    expect(credential.challenge.intent).toBe("charge");
  });

  it("echoes the challenge back unchanged", async () => {
    // The server recomputes its HMAC over these parameters, so anything
    // this client rewrites is a challenge the server will refuse.
    const challenge = await chargeChallenge({
      amountSat: 100,
      label: "charge",
      expires: "2099-01-01T00:00:00Z",
      description: "Weather report, hourly",
    });

    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([challenge])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");
    await client(URL_UNDER_TEST);

    const echoed = parseCredential(calls[1]?.authorization as string).challenge;
    expect(echoed).toEqual({
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      expires: challenge.expires,
      description: challenge.description,
    });
  });

  it("leaves the DID payer identifier unset", async () => {
    // This is the first field in the stack that would let a seller
    // correlate a buyer across payments, so nothing here populates it.
    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");
    await client(URL_UNDER_TEST);

    // Parse first. A body that decoded to nothing recognizable would also
    // fail to contain "source", so the absence only means something once
    // the credential is known to be well formed.
    const authorization = calls[1]?.authorization as string;
    const credential = parseCredential(authorization);

    expect(credential.payload).toBeDefined();
    expect(credential).not.toHaveProperty("source");

    const token = authorization.slice("Payment ".length);
    expect(Buffer.from(token, "base64url").toString()).not.toContain("source");
  });

  it("re-sends the original POST body on the paid retry", async () => {
    const payload = JSON.stringify({ prompt: "hello", max_tokens: 42 });

    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(calls[0]?.body).toBe(payload);
    expect(calls[1]?.body).toBe(payload);
  });

  it("returns a second 402 rather than paying again", async () => {
    // A client that pays again when the paid request is refused has built a
    // loop with a wallet attached to it.
    const { calls } = stubFetch(async () =>
      challengeResponse([
        await chargeChallenge({ amountSat: 100, label: "charge" }),
      ]),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(calls).toHaveLength(2);
    expect(payer.paid).toHaveLength(1);
  });

  it("presents the paid credential again instead of buying a second", async () => {
    // The retry throwing after the money moved is the failure this cache
    // exists for: without it the next attempt fetches a fresh challenge and
    // pays for the same thing twice.
    let attempt = 0;
    const { calls } = stubFetch(async (_sent, index) => {
      attempt += 1;
      if (index === 0) {
        return challengeResponse([
          await chargeChallenge({
            amountSat: 100,
            label: "charge",
            expires: "2099-01-01T00:00:00Z",
          }),
        ]);
      }
      if (attempt === 2) throw new Error("connection reset");
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/connection reset/);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toHaveLength(1);
    expect(calls[2]?.authorization).toBe(calls[1]?.authorization);
  });

  it("refuses to pay against an expired challenge", async () => {
    const { calls } = stubFetch(async () =>
      challengeResponse([
        await chargeChallenge({
          amountSat: 100,
          label: "charge",
          expires: "2020-01-01T00:00:00Z",
        }),
      ]),
    );

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/expired at/);
    expect(payer.paid).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("refuses an invoice whose amount cannot be decoded", async () => {
    const challenge = await chargeChallenge({ amountSat: 100, label: "bad" });
    const { calls } = stubFetch(async () =>
      challengeResponse([
        // Rebuild the request with an invoice the amount decoder rejects.
        await chargeChallengeWithInvoice(challenge, "xyz2500u1nonsense"),
      ]),
    );

    const { client, payer } = newClient({ intents: ["charge"] });

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(
      /could not be decoded/,
    );
    expect(payer.paid).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("asserts the buyer policy before paying", async () => {
    const assertAllowed = vi.fn(async () => {
      throw new Error("over budget");
    });

    stubFetch(async () =>
      challengeResponse([
        await chargeChallenge({ amountSat: 100, label: "charge" }),
      ]),
    );

    const { client, payer } = newClient({
      intents: ["charge"],
      buyerPolicy: { assertAllowed },
    });
    await payer.expectLabel(100, "charge");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/over budget/);
    expect(payer.paid).toEqual([]);
  });

  it("writes the spend to the receipt ledger before retrying", async () => {
    // The retry has to fail for "before" to mean anything. Against a retry
    // that succeeds, a ledger written afterwards looks identical, and the
    // ordering this test is named for goes unchecked.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await chargeChallenge({ amountSat: 100, label: "charge" }),
        ]);
      }
      throw new Error("connection reset");
    });

    const { client, payer, receiptCache } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/connection reset/);

    const entry = receiptCache.get(await hashFor("charge"));
    expect(entry?.amountSat).toBe(100);
    expect(entry?.preimageHex).toBe(preimageFor("charge"));
  });

  it("serves the paid response when the post-payment stores fail", async () => {
    // The money is gone the moment the payer settles. A ledger that refuses
    // the write costs a gap in the audit trail; failing here would cost the
    // caller the whole payment, which is strictly worse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({
      intents: ["charge"],
      receiptStore: {
        store() {
          throw new Error("ledger offline");
        },
      },
      credentialStore: {
        get: () => null,
        put() {
          throw new Error("disk full");
        },
        delete: () => undefined,
      },
    });
    await payer.expectLabel(100, "charge");

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("session intent", () => {
  it("opens a session with the open handshake, then speaks bearer", async () => {
    // The seller here enforces the reference state machine: a session
    // exists only once an open credential carrying the deposit preimage and
    // the return invoice has been accepted, and a bearer without that
    // handshake, or without the preimage, is refused. This is the dialect
    // the real server speaks, so it is the one the tests must fail on.
    const seller = new SessionSeller({
      offer: await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "deposit",
      }),
    });
    const { calls } = stubFetch(async (sent) => seller.handle(sent.authorization));

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    const first = await client(URL_UNDER_TEST);
    const second = await client(URL_UNDER_TEST);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(payer.paid).toHaveLength(1);
    expect(seller.refusals).toEqual([]);
    expect(calls).toHaveLength(3);

    const opened = sessionPayload(calls[1]?.authorization ?? null);
    expect(opened.action).toBe("open");
    expect(opened.preimage).toBe(preimageFor("deposit"));
    expect(opened.returnInvoice).toBeTruthy();

    const bearer = sessionPayload(calls[2]?.authorization ?? null);
    expect(bearer.action).toBe("bearer");
    expect(bearer.sessionId).toBe(await hashFor("deposit"));
    expect(bearer.preimage).toBe(preimageFor("deposit"));
  });

  it("re-presents an open handshake whose response was lost", async () => {
    // The server may or may not have seen the open that never answered, so
    // the handshake stays owed. Re-presenting it costs nothing at the
    // wallet, and it is the only credential that can deliver the deposit.
    const seller = new SessionSeller({
      offer: await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "deposit",
      }),
    });

    let dropOpen = true;
    stubFetch(async (sent) => {
      const authorization = sent.authorization;
      if (authorization !== null && dropOpen) {
        const payload = sessionPayload(authorization);
        if (payload.action === "open") {
          dropOpen = false;
          throw new Error("connection reset");
        }
      }
      return seller.handle(authorization);
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/connection reset/);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toHaveLength(1);
    expect(seller.refusals).toEqual([]);
  });

  it("converges on bearer after the server refuses a replayed open", async () => {
    // The open was accepted but its response never arrived. The replay is
    // refused outright, which retires the handshake, and the next request
    // probes with the bearer credential the accepted open already earned.
    const seller = new SessionSeller({
      offer: await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "deposit",
      }),
    });

    let dropped = false;
    stubFetch(async (sent) => {
      const response = await seller.handle(sent.authorization);
      if (sent.authorization !== null && !dropped) {
        const payload = sessionPayload(sent.authorization);
        if (payload.action === "open") {
          // The seller processed the open; the answer is lost on the way
          // back.
          dropped = true;
          throw new Error("connection reset");
        }
      }
      return response;
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/connection reset/);

    // The replayed open is refused; the 402 goes back to the caller.
    const refused = await client(URL_UNDER_TEST);
    expect(refused.status).toBe(402);

    // The handshake is retired, so this request presents the bearer the
    // accepted open earned, and no second deposit is ever bought.
    const served = await client(URL_UNDER_TEST);
    expect(served.status).toBe(200);
    expect(payer.paid).toHaveLength(1);
  });

  it("delivers an unacknowledged top-up before anything else", async () => {
    // A topUp whose response was lost is re-presented rather than repaid:
    // its replay is defined to credit at most once, so presenting it again
    // is free, while paying again would strand the first top-up.
    const openOffer = await sessionChallenge({
      depositSat: 2,
      pricePerUnitSat: 2,
      label: "deposit",
    });
    const seller = new SessionSeller({
      offer: openOffer,
      topUpOffer: await sessionChallenge({
        depositSat: 500,
        pricePerUnitSat: 2,
        label: "topup",
      }),
    });

    let dropTopUp = true;
    stubFetch(async (sent) => {
      const response = await seller.handle(sent.authorization);
      if (sent.authorization !== null && dropTopUp) {
        const payload = sessionPayload(sent.authorization);
        if (payload.action === "topUp") {
          dropTopUp = false;
          throw new Error("connection reset");
        }
      }
      return response;
    });

    const { client, payer } = newClient();
    await payer.expectLabel(2, "deposit");
    await payer.expectLabel(500, "topup");

    // Open on the first call, then drain the 2-sat deposit with one bearer.
    await client(URL_UNDER_TEST);
    await client(URL_UNDER_TEST);

    // The next request finds the balance empty, pays the top-up, and the
    // topUp presentation's response is lost after the seller credits it.
    await expect(client(URL_UNDER_TEST)).rejects.toThrow(/connection reset/);

    // The replay is answered without crediting twice, and the session works.
    const response = await client(URL_UNDER_TEST);
    expect(response.status).toBe(200);
    expect(payer.paid).toEqual([
      invoiceFor(2, "deposit"),
      invoiceFor(500, "topup"),
    ]);
  });

  it("prefers a session over a charge when both are offered", async () => {
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST);
    expect(payer.paid).toEqual([invoiceFor(300, "deposit")]);
  });

  it("declines a session it cannot get a refund out of and takes the charge", async () => {
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ minter: null });
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST);
    expect(payer.paid).toEqual([invoiceFor(100, "charge")]);
  });

  it("spends the session on later requests without touching the wallet", async () => {
    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    await client(URL_UNDER_TEST);
    await client(URL_UNDER_TEST);

    // One challenge, one deposit, and a bearer credential on every request
    // after the first, with no further 402s and no further payments.
    expect(payer.paid).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect(sessionPayload(calls[2]?.authorization ?? null).action).toBe(
      "bearer",
    );
    expect(sessionPayload(calls[3]?.authorization ?? null).action).toBe(
      "bearer",
    );
  });

  it("draws the balance estimate down as it spends", async () => {
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    await client(URL_UNDER_TEST);

    // The first call's paid retry carries the open handshake, which the
    // server serves without a deduction, so only the second call's bearer
    // request draws the estimate down.
    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(session).not.toBeNull();
    expect(client.sessions.remainingSat(session!)).toBe(298);
  });

  it("tops up once when the server says the balance ran out", async () => {
    const { calls } = stubFetch(async (sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });

      // The next bearer request finds the balance spent.
      if (sessionPayload(sent.authorization).action === "bearer" && index === 2) {
        return challengeResponse(
          [
            await sessionChallenge({
              depositSat: 500,
              pricePerUnitSat: 2,
              label: "topup",
            }),
          ],
          { type: PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(500, "topup");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toEqual([
      invoiceFor(300, "deposit"),
      invoiceFor(500, "topup"),
    ]);

    // The top-up keeps the session, and the retry is what delivers it: a
    // topUp credential proving the fresh invoice's preimage against the
    // very challenge it echoes, under the original session id.
    const payload = sessionPayload(calls[3]?.authorization ?? null);
    expect(payload.action).toBe("topUp");
    expect(payload.sessionId).toBe(await hashFor("deposit"));
    expect(payload.topUpPreimage).toBe(preimageFor("topup"));

    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(session?.depositedSat).toBe(800);

    // The server said the balance was gone, so the whole first deposit is
    // spent and only the top-up is left. The topUp-carrying retry itself is
    // served without a deduction. Carrying the stale estimate forward
    // instead would leave the client believing it still had the first
    // deposit to spend.
    expect(client.sessions.remainingSat(session!)).toBe(500);
  });

  it("does not top up a request the caller has abandoned", async () => {
    // Same rule as the open and charge paths: the wallet must not spend on
    // a response nobody is waiting for. The top-up is the third way into a
    // payment and the only one that starts from a session already open.
    const controller = new AbortController();

    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });

      controller.abort();
      return challengeResponse(
        [
          await sessionChallenge({
            depositSat: 500,
            pricePerUnitSat: 2,
            label: "topup",
          }),
        ],
        { type: PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE },
      );
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(500, "topup");

    await client(URL_UNDER_TEST);
    await expect(
      client(URL_UNDER_TEST, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);

    expect(payer.paid).toEqual([invoiceFor(300, "deposit")]);
  });

  it("opens a replacement when the server has forgotten the session", async () => {
    const { calls } = stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      if (index === 2) {
        return challengeResponse(
          [
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "second",
            }),
          ],
          { type: PROBLEM_LIGHTNING_SESSION_NOT_FOUND },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(300, "second");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toHaveLength(2);

    // The replacement session starts with its own open handshake, whose
    // preimage is the proof of which deposit it delivers.
    const payload = sessionPayload(calls[3]?.authorization ?? null);
    expect(payload.action).toBe("open");
    expect(payload.preimage).toBe(preimageFor("second"));
  });

  it("does not top up a session the server has already closed", async () => {
    // Topping up a session the server discarded burns the top-up, so a
    // closed session gets replaced rather than refilled.
    const { calls } = stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      if (index === 2) {
        return challengeResponse(
          [
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "second",
            }),
          ],
          { type: PROBLEM_LIGHTNING_SESSION_CLOSED },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(300, "second");

    await client(URL_UNDER_TEST);
    await client(URL_UNDER_TEST);

    const payload = sessionPayload(calls[3]?.authorization ?? null);
    expect(payload.action).toBe("open");
    expect(payload.preimage).toBe(preimageFor("second"));
  });

  it("hands back the 402 when the refusal is not about the balance", async () => {
    // Neither recovery applies, and both cost money, so the server's own
    // answer goes to the caller rather than a guess.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      return challengeResponse(
        [
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "second",
          }),
        ],
        { type: PROBLEM_VERIFICATION_FAILED },
      );
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(300, "second");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(payer.paid).toHaveLength(1);
  });

  it("does not buy a second deposit when the refusal is unexplained", async () => {
    // The session intent is off the table after a refusal neither recovery
    // explains, and the only way to see that is to offer a session the
    // client does not already hold. A replacement offered under the realm
    // the client is already in resolves to the session it has, so a client
    // that took the offer anyway would look identical to one that refused.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      return challengeResponse(
        [
          await sessionChallenge({
            depositSat: 900,
            pricePerUnitSat: 2,
            label: "elsewhere",
            realm: "other.example.com",
          }),
        ],
        { type: PROBLEM_VERIFICATION_FAILED },
      );
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(900, "elsewhere");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(payer.paid).toEqual([invoiceFor(300, "deposit")]);

    // And no second session was opened alongside the first.
    expect(await client.sessions.listOpen()).toHaveLength(1);
  });

  it("does not draw the estimate down on a request the server refused", async () => {
    // The estimate stands for what the server has charged. A response the
    // server did not serve is one it did not price, and counting it would
    // walk the balance to zero on an endpoint that is simply broken.
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("nope", { status: 500 }),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    const response = await client(URL_UNDER_TEST);
    expect(response.status).toBe(500);

    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(client.sessions.remainingSat(session!)).toBe(300);
  });

  it("does not draw the estimate down on a refused bearer request", async () => {
    // Same rule on the other path: a bearer request that never reaches a
    // 402 is charged in the paying fetch itself rather than in the flow.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      return new Response("nope", { status: 500 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    expect((await client(URL_UNDER_TEST)).status).toBe(500);

    // Nothing has drawn the estimate down: the first call's retry carried
    // the open handshake, which is served without a deduction, and the
    // second call's bearer request was refused.
    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(client.sessions.remainingSat(session!)).toBe(300);
  });

  it("hands back a 402 whose body the caller can still read", async () => {
    // The 402 is returned precisely so the caller can see why. A body can
    // be read once, so reading the problem document out of it internally
    // would leave the caller holding a response that throws.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      return challengeResponse(
        [
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "second",
          }),
        ],
        {
          type: PROBLEM_VERIFICATION_FAILED,
          detail: "Credential did not verify",
        },
      );
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({
      type: PROBLEM_VERIFICATION_FAILED,
      detail: "Credential did not verify",
    });
  });

  it("takes a charge offer when a session refusal is unexplained", async () => {
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });
      if (index === 2) {
        return challengeResponse(
          [await chargeChallenge({ amountSat: 100, label: "charge" })],
          { type: PROBLEM_VERIFICATION_FAILED },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(payer.paid).toEqual([
      invoiceFor(300, "deposit"),
      invoiceFor(100, "charge"),
    ]);
  });
});

describe("the one-payment-per-call bound", () => {
  it("does not pay a second time when the topped-up retry is refused", async () => {
    // The retry after a payment is the last thing this call does. A client
    // that pays again when that retry is refused has built a loop with a
    // wallet attached to it.
    stubFetch(async (_sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (index === 1) return new Response("ok", { status: 200 });

      // Every request from here on is refused for insufficient balance,
      // top-up challenge included.
      return challengeResponse(
        [
          await sessionChallenge({
            depositSat: 500,
            pricePerUnitSat: 2,
            label: "topup",
          }),
        ],
        { type: PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE },
      );
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(500, "topup");

    await client(URL_UNDER_TEST);
    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(payer.paid).toEqual([
      invoiceFor(300, "deposit"),
      invoiceFor(500, "topup"),
    ]);
  });

  it("does not pay a second time when the opened retry is refused", async () => {
    stubFetch(async () =>
      challengeResponse([
        await sessionChallenge({
          depositSat: 300,
          pricePerUnitSat: 2,
          label: "deposit",
        }),
      ]),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(payer.paid).toHaveLength(1);
  });

  it("does not spend on a request the caller has abandoned", async () => {
    // The wallet must not pay for a response nobody is waiting for. The
    // abort is checked again after the policy resolves, since the caller
    // may have given up while it was deciding.
    const controller = new AbortController();

    stubFetch(async () => {
      controller.abort();
      return challengeResponse([
        await chargeChallenge({ amountSat: 100, label: "charge" }),
      ]);
    });

    const { client, payer } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await expect(
      client(URL_UNDER_TEST, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(payer.paid).toEqual([]);
  });

  it("does not spend on an abandoned request under a session", async () => {
    const controller = new AbortController();

    stubFetch(async () => {
      controller.abort();
      return challengeResponse([
        await sessionChallenge({
          depositSat: 300,
          pricePerUnitSat: 2,
          label: "deposit",
        }),
      ]);
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await expect(
      client(URL_UNDER_TEST, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(payer.paid).toEqual([]);
  });
});

describe("concurrent requests against one session", () => {
  it("opens one session and pays one deposit", async () => {
    const { calls } = stubFetch(async (sent, index) => {
      if (sent.authorization === null) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      return new Response(`ok-${index}`, { status: 200 });
    });

    const { client, payer, sessionStore } = newClient();
    await payer.expectLabel(300, "deposit");

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => client(URL_UNDER_TEST)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(payer.paid).toHaveLength(1);
    expect(sessionStore.size).toBe(1);

    // Six challenges and six paid retries, but only one deposit between
    // them.
    expect(calls).toHaveLength(12);
  });

  it("pays one top-up when several requests exhaust the balance at once", async () => {
    // The seller refuses every bearer request until a top-up has settled,
    // and serves them once one has. Letting the three concurrent requests
    // succeed is the point: a run where all three rejected would satisfy
    // the payment count on its own, and swallowing their outcomes would
    // make this test pass on a client that lost every request it coalesced.
    const payer = new ScriptedPayer();
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(500, "topup");

    const { calls } = stubFetch(async (sent) => {
      if (sent.authorization === null) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }

      const payload = sessionPayload(sent.authorization);
      if (
        payload.action === "bearer" &&
        calls.length > 2 &&
        payer.paid.length < 2
      ) {
        return challengeResponse(
          [
            await sessionChallenge({
              depositSat: 500,
              pricePerUnitSat: 2,
              label: "topup",
            }),
          ],
          { type: PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client } = newClient({ payer });

    const first = await client(URL_UNDER_TEST);
    const responses = await Promise.all([
      client(URL_UNDER_TEST),
      client(URL_UNDER_TEST),
      client(URL_UNDER_TEST),
    ]);

    expect(first.status).toBe(200);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(payer.paid).toEqual([
      invoiceFor(300, "deposit"),
      invoiceFor(500, "topup"),
    ]);
  });
});

describe("closing sessions", () => {
  it("closes every open session and reports the refunds", async () => {
    stubFetch(async (sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }

      if (sent.authorization !== null) {
        const payload = sessionPayload(sent.authorization);
        if (payload.action === "close") {
          return receiptResponse({
            reference: payload.sessionId as string,
            refundSats: 296,
            refundStatus: "succeeded",
          });
        }
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    const outcomes = await client.closeSessions();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.refundSats).toBe(296);
    expect(outcomes[0]?.refundStatus).toBe("succeeded");
    expect(await client.sessions.listOpen()).toEqual([]);
  });

  it("lets the caller supply the close request", async () => {
    // Which request a server expects a close on is the least settled part
    // of the session draft, so a seller that wants something other than a
    // bodyless GET has somewhere to say so.
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");
    await client(URL_UNDER_TEST);

    const sent: string[] = [];
    const outcomes = await client.closeSessions(async ({ url, authorization }) => {
      sent.push(`${url} ${authorization.slice(0, 8)}`);
      return receiptResponse({
        reference: await hashFor("deposit"),
        refundSats: 298,
        refundStatus: "succeeded",
      });
    });

    expect(sent).toEqual([`${URL_UNDER_TEST} Payment `]);
    expect(outcomes[0]?.refundSats).toBe(298);
  });

  it("reports a refund the server skipped", async () => {
    stubFetch(async (sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (sent.authorization !== null) {
        const payload = sessionPayload(sent.authorization);
        if (payload.action === "close") {
          return receiptResponse({
            reference: payload.sessionId as string,
            refundStatus: "skipped",
          });
        }
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient();
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    const outcomes = await client.closeSessions();

    expect(outcomes[0]?.refundStatus).toBe("skipped");
    expect(outcomes[0]?.refundSats).toBe(0);
  });
});

describe("credential precedence", () => {
  it("prefers a route-scoped L402 token over an origin-wide session", async () => {
    // A session is found by guessing at the realm from the origin alone. If
    // it outranked a token already paid for this exact route, an origin
    // serving both protocols would present a bearer credential, be refused,
    // and buy the same token a second time.
    const l402Url = "https://api.example.com/l402";
    const tokenCache = new TokenCache();
    tokenCache.put(
      TokenCache.cacheKey("https://api.example.com", "/l402", "GET"),
      {
        macaroonB64: "AQIDBA==",
        preimageHex: preimageFor("l402"),
        expiresAt: "2099-01-01T00:00:00Z",
      },
    );

    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await sessionChallenge({
              depositSat: 300,
              pricePerUnitSat: 2,
              label: "deposit",
            }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ tokenCache });
    await payer.expectLabel(300, "deposit");

    await client(URL_UNDER_TEST);
    const response = await client(l402Url);

    expect(response.status).toBe(200);
    expect(payer.paid).toEqual([invoiceFor(300, "deposit")]);
    expect(calls[2]?.authorization).toBe(
      `L402 AQIDBA==:${preimageFor("l402")}`,
    );
  });

  it("drops a cached credential the server refused", async () => {
    // A credential the server refused is spent or bound to a challenge that
    // is gone. Keeping it would cost a wasted round trip on every later
    // request to this route, and a credential with no expiry has nothing to
    // age it out.
    const credentialCache = new CredentialCache();
    const key = CredentialCache.cacheKey(
      "https://api.example.com",
      "/infer",
      "GET",
    );
    credentialCache.put(key, {
      authorization: "Payment c3RhbGU",
      challengeId: "ch_stale",
    });

    stubFetch(async (sent) =>
      sent.authorization === "Payment c3RhbGU"
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient({ credentialCache, intents: ["charge"] });
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST);

    // The stale entry is gone, replaced by the credential just paid for.
    expect(credentialCache.get(key)?.authorization).not.toBe(
      "Payment c3RhbGU",
    );
    expect(payer.paid).toEqual([invoiceFor(100, "charge")]);
  });

  it("does not attribute a refused cached credential to the session", async () => {
    // The session exists but was not the credential the server refused, so
    // a session-not-found problem in that 402 is about something else and
    // must not discard the session, along with its refund.
    const chargeUrl = "https://api.example.com/charge";
    const credentialCache = new CredentialCache();
    credentialCache.put(
      CredentialCache.cacheKey("https://api.example.com", "/charge", "GET"),
      { authorization: "Payment c3RhbGU", challengeId: "ch_stale" },
    );

    stubFetch(async (sent, index) => {
      if (index === 0) {
        return challengeResponse([
          await sessionChallenge({
            depositSat: 300,
            pricePerUnitSat: 2,
            label: "deposit",
          }),
        ]);
      }
      if (sent.url.endsWith("/charge") && sent.authorization === "Payment c3RhbGU") {
        return challengeResponse(
          [await chargeChallenge({ amountSat: 100, label: "charge" })],
          { type: PROBLEM_LIGHTNING_SESSION_NOT_FOUND },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const { client, payer } = newClient({ credentialCache });
    await payer.expectLabel(300, "deposit");
    await payer.expectLabel(100, "charge");

    await client(URL_UNDER_TEST);
    const response = await client(chargeUrl);

    expect(response.status).toBe(200);
    expect(payer.paid).toEqual([
      invoiceFor(300, "deposit"),
      invoiceFor(100, "charge"),
    ]);

    // The session is untouched: still open, still closable, still refundable.
    expect(await client.sessions.listOpen()).toHaveLength(1);
  });
});

describe("coexistence with L402", () => {
  it("leaves an L402-only challenge to the L402 path", async () => {
    const { calls } = stubFetch(async (_sent, index) =>
      index === 0
        ? new Response(
            JSON.stringify({
              challenge_id: "ch_test",
              route_id: "api",
              amount_sat: 10,
              invoice: "lnbc100n1fake",
              macaroon: "AQIDBA==",
              expires_at: "2099-01-01T00:00:00Z",
            }),
            {
              status: 402,
              headers: { "Content-Type": "application/json" },
            },
          )
        : new Response("ok", { status: 200 }),
    );

    const { client, payer } = newClient();
    payer.expect("lnbc100n1fake", preimageFor("l402"));

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls[1]?.authorization).toBe(
      `L402 AQIDBA==:${preimageFor("l402")}`,
    );
  });
});

/** Rebuild a charge challenge around a different invoice string. */
async function chargeChallengeWithInvoice(
  challenge: Awaited<ReturnType<typeof chargeChallenge>>,
  invoice: string,
): Promise<typeof challenge> {
  const { decodeRequestObject, encodeRequestObject, computeChallengeId } =
    await import("@aperture/core/mpp");
  const { SELLER_SECRET } = await import("../mpp/fixtures.js");

  const request = decodeRequestObject<{
    amount: string;
    currency: string;
    methodDetails: { invoice: string };
  }>(challenge.request);
  request.methodDetails.invoice = invoice;
  request.amount = "0";

  const rebuilt = {
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: encodeRequestObject(request as never),
  };

  return { id: await computeChallengeId(SELLER_SECRET, rebuilt), ...rebuilt };
}
