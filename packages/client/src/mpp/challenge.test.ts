import { describe, it, expect } from "vitest";
import {
  encodeRequestObject,
  formatChallengeHeader,
  type ChallengeParams,
} from "@aperture/core/mpp";
import {
  isChallengeExpired,
  paymentChallengesFromHeaders,
  readProblem,
  selectChallenge,
  toTypedChallenge,
  type PaymentChallenge,
} from "./challenge.js";
import { challengeResponse, chargeChallenge, sessionChallenge } from "./fixtures.js";

describe("paymentChallengesFromHeaders", () => {
  it("reads both offers off a 402 that carries two", async () => {
    const response = challengeResponse([
      await chargeChallenge({ amountSat: 100, label: "charge" }),
      await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "session",
      }),
    ]);

    const challenges = paymentChallengesFromHeaders(response);
    expect(challenges.map((c) => c.intent)).toEqual(["charge", "session"]);
  });

  it("decodes the intent-specific request object", async () => {
    const response = challengeResponse([
      await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "session",
      }),
    ]);

    const challenge = paymentChallengesFromHeaders(response)[0];
    expect(challenge?.intent).toBe("session");
    if (challenge?.intent !== "session") throw new Error("wrong intent");

    expect(challenge.request.amount).toBe("2");
    expect(challenge.request.depositAmount).toBe("300");
    expect(challenge.request.depositInvoice).toContain("lnbc");
  });

  it("leaves the response body unread", async () => {
    // A 402 body can be read once, and which protocol gets to read it is
    // decided from the headers.
    const response = challengeResponse(
      [await chargeChallenge({ amountSat: 100, label: "charge" })],
      { type: "https://paymentauth.org/problems/payment-required" },
    );

    paymentChallengesFromHeaders(response);
    expect(response.bodyUsed).toBe(false);
    expect(await readProblem(response)).not.toBeNull();
  });

  it("returns nothing for a 402 with no Payment challenge", () => {
    const response = new Response(null, {
      status: 402,
      headers: {
        "WWW-Authenticate": 'L402 macaroon="AQIDBA", invoice="lnbc1fake"',
      },
    });

    expect(paymentChallengesFromHeaders(response)).toEqual([]);
  });
});

describe("toTypedChallenge", () => {
  const base: ChallengeParams = {
    id: "id",
    realm: "r",
    method: "lightning",
    intent: "charge",
    request: encodeRequestObject({
      amount: "10",
      currency: "sat",
      methodDetails: { invoice: "lnbc100n1fake" },
    }),
  };

  it("drops an unknown payment method", () => {
    expect(toTypedChallenge({ ...base, method: "ach" })).toBeNull();
  });

  it("drops an unknown intent", () => {
    expect(toTypedChallenge({ ...base, intent: "subscription" })).toBeNull();
  });

  it("drops a charge whose request has no invoice", () => {
    expect(
      toTypedChallenge({
        ...base,
        request: encodeRequestObject({ amount: "10", currency: "sat" }),
      }),
    ).toBeNull();
  });

  it("drops a session whose request has no payment hash", () => {
    expect(
      toTypedChallenge({
        ...base,
        intent: "session",
        request: encodeRequestObject({ amount: "2", currency: "sat" }),
      }),
    ).toBeNull();
  });

  it("drops a request parameter that is not decodable", () => {
    expect(toTypedChallenge({ ...base, request: "!!!!" })).toBeNull();
  });

  it("keeps a usable offer sitting next to an unusable one", () => {
    const response = new Response(null, {
      status: 402,
      headers: {
        "WWW-Authenticate": [
          formatChallengeHeader({ ...base, id: "bad", request: "!!!!" }),
          formatChallengeHeader({ ...base, id: "good" }),
        ].join(", "),
      },
    });

    const challenges = paymentChallengesFromHeaders(response);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.params.id).toBe("good");
  });
});

describe("selectChallenge", () => {
  async function offers(): Promise<PaymentChallenge[]> {
    const response = challengeResponse([
      await chargeChallenge({ amountSat: 100, label: "charge" }),
      await sessionChallenge({
        depositSat: 300,
        pricePerUnitSat: 2,
        label: "session",
      }),
    ]);
    return paymentChallengesFromHeaders(response);
  }

  it("honors the caller's preference order", async () => {
    const challenges = await offers();

    expect(selectChallenge(challenges, ["session", "charge"])?.intent).toBe(
      "session",
    );
    expect(selectChallenge(challenges, ["charge", "session"])?.intent).toBe(
      "charge",
    );
  });

  it("falls past an offer the caller vetoes", async () => {
    const challenges = await offers();

    const selected = selectChallenge(
      challenges,
      ["session", "charge"],
      (c) => c.intent !== "session",
    );
    expect(selected?.intent).toBe("charge");
  });

  it("returns null when nothing is acceptable", async () => {
    expect(selectChallenge(await offers(), ["subscription"])).toBeNull();
  });
});

describe("isChallengeExpired", () => {
  const at = (expires?: string): ChallengeParams => ({
    id: "id",
    realm: "r",
    method: "lightning",
    intent: "charge",
    request: "eyJhIjoxfQ",
    ...(expires === undefined ? {} : { expires }),
  });

  it("treats a challenge with no expiry as live", () => {
    expect(isChallengeExpired(at())).toBe(false);
  });

  it("compares against the given instant", () => {
    const expires = "2026-03-15T12:05:00Z";
    const at1204 = Date.parse("2026-03-15T12:04:00Z");
    const at1206 = Date.parse("2026-03-15T12:06:00Z");

    expect(isChallengeExpired(at(expires), at1204)).toBe(false);
    expect(isChallengeExpired(at(expires), at1206)).toBe(true);
  });

  it("treats an unparseable expiry as expired", () => {
    // The alternative is an immortal challenge built from garbage, and
    // paying against a challenge the server will refuse costs real money
    // for nothing.
    expect(isChallengeExpired(at("not a timestamp"))).toBe(true);
    expect(isChallengeExpired(at("2026-13-45T99:99:99Z"))).toBe(true);
  });
});

describe("readProblem", () => {
  it("reads an RFC 9457 problem document", async () => {
    const response = challengeResponse([], {
      type: "https://paymentauth.org/problems/lightning/insufficient-balance",
      detail: "Session balance exhausted",
    });

    const problem = await readProblem(response);
    expect(problem?.type).toContain("insufficient-balance");
    expect(problem?.detail).toBe("Session balance exhausted");
  });

  it("returns null when there is no body", async () => {
    expect(await readProblem(challengeResponse([]))).toBeNull();
  });

  it("returns null rather than throwing on a malformed body", async () => {
    // The problem document is a hint about how to recover; a malformed hint
    // must not become the failure.
    const response = new Response("{not json", {
      status: 402,
      headers: { "Content-Type": "application/problem+json" },
    });

    expect(await readProblem(response)).toBeNull();
  });

  it("returns null for a JSON body with no problem type", async () => {
    const response = new Response(JSON.stringify({ error: "nope" }), {
      status: 402,
      headers: { "Content-Type": "application/json" },
    });

    expect(await readProblem(response)).toBeNull();
  });
});
