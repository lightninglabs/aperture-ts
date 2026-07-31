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
import { CredentialCache } from "../cache/credentialCache.js";
import { TokenCache } from "../cache/tokenCache.js";
import { ReceiptCache } from "../cache/receiptCache.js";
import { MockReturnInvoiceMinter } from "../mpp/mockMinter.js";
import {
  ScriptedPayer,
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
    receiptCache,
    tokenCache,
    ...(overrides.buyerPolicy === undefined
      ? {}
      : { buyerPolicy: overrides.buyerPolicy as never }),
    mpp: {
      sessionStore,
      credentialCache,
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

    const token = (calls[1]?.authorization as string).slice("Payment ".length);
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
    stubFetch(async (_sent, index) =>
      index === 0
        ? challengeResponse([
            await chargeChallenge({ amountSat: 100, label: "charge" }),
          ])
        : new Response("ok", { status: 200 }),
    );

    const { client, payer, receiptCache } = newClient({ intents: ["charge"] });
    await payer.expectLabel(100, "charge");
    await client(URL_UNDER_TEST);

    const entry = receiptCache.get(await hashFor("charge"));
    expect(entry?.amountSat).toBe(100);
    expect(entry?.preimageHex).toBe(preimageFor("charge"));
  });
});

describe("session intent", () => {
  it("opens a session and retries once with a bearer credential", async () => {
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

    const response = await client(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(payer.paid).toHaveLength(1);

    const payload = sessionPayload(calls[1]?.authorization ?? null);
    expect(payload.action).toBe("bearer");
    expect(payload.sessionId).toBe(await hashFor("deposit"));
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

    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(session).not.toBeNull();
    expect(client.sessions.remainingSat(session!)).toBe(296);
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

    // The top-up keeps the session, so the retry is still a bearer request
    // under the original session id.
    const payload = sessionPayload(calls[3]?.authorization ?? null);
    expect(payload.action).toBe("bearer");
    expect(payload.sessionId).toBe(await hashFor("deposit"));

    const session = await client.sessions.findForOrigin(
      "https://api.example.com",
    );
    expect(session?.depositedSat).toBe(800);
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
    expect(sessionPayload(calls[3]?.authorization ?? null).sessionId).toBe(
      await hashFor("second"),
    );
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
    expect(payload.action).toBe("bearer");
    expect(payload.sessionId).toBe(await hashFor("second"));
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
      if (payload.action === "bearer" && calls.length > 2) {
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
    await Promise.all([
      client(URL_UNDER_TEST).catch(() => undefined),
      client(URL_UNDER_TEST).catch(() => undefined),
      client(URL_UNDER_TEST).catch(() => undefined),
    ]);

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
