import { describe, it, expect } from "vitest";
import { parseCredential, type ChallengeParams } from "@lightninglabs/aperture-core/mpp";
import {
  buildChargeCredential,
  buildSessionCredential,
  toAuthorizationHeader,
  toChallengeEcho,
} from "./credential.js";

const FULL: ChallengeParams = {
  id: "x7Tg2pLqR9mKvNwY3hBcZa",
  realm: "api.example.com",
  method: "lightning",
  intent: "charge",
  request: "eyJhbW91bnQiOiIxMDAifQ",
  expires: "2026-03-15T12:05:00Z",
  digest: "sha-256=:abc:",
  description: "Weather report",
  opaque: "eyJvcmRlciI6IjEyMyJ9",
};

const MINIMAL: ChallengeParams = {
  id: "minimal",
  realm: "api.example.com",
  method: "lightning",
  intent: "session",
  request: "eyJhbW91bnQiOiIyIn0",
};

describe("toChallengeEcho", () => {
  it("carries every parameter back unchanged", () => {
    // The server recomputes its HMAC over these, so an echo that rewrites
    // anything is a credential the server refuses.
    expect(toChallengeEcho(FULL)).toEqual({
      id: FULL.id,
      realm: FULL.realm,
      method: FULL.method,
      intent: FULL.intent,
      request: FULL.request,
      expires: FULL.expires,
      description: FULL.description,
      opaque: FULL.opaque,
      digest: FULL.digest,
    });
  });

  it("leaves absent parameters absent", () => {
    // An empty string is a different HMAC slot than an omitted field, so
    // filling one in would change what the server computes.
    const echo = toChallengeEcho(MINIMAL);

    expect(Object.keys(echo).sort()).toEqual([
      "id",
      "intent",
      "method",
      "realm",
      "request",
    ]);
  });
});

describe("buildChargeCredential", () => {
  it("produces a credential a Payment server accepts", () => {
    const header = toAuthorizationHeader(
      buildChargeCredential(FULL, "ab".repeat(32)),
    );

    const parsed = parseCredential<{ preimage: string }>(header);
    expect(parsed.challenge.id).toBe(FULL.id);
    expect(parsed.payload.preimage).toBe("ab".repeat(32));
  });

  it("leaves the payer identifier unset by default", () => {
    const header = toAuthorizationHeader(buildChargeCredential(FULL, "ab"));

    // Parsing first is what makes the absence mean something: a token whose
    // bytes decoded to anything unrecognizable would also fail to contain
    // "source".
    const parsed = parseCredential(header);
    expect(parsed.challenge.id).toBe(FULL.id);
    expect(parsed).not.toHaveProperty("source");

    const token = header.slice("Payment ".length);
    expect(Buffer.from(token, "base64url").toString()).not.toContain("source");
  });

  it("carries a payer identifier only when one is handed to it", () => {
    // The field is wired so the decision has somewhere to land, not because
    // anything in this client fills it in.
    const header = toAuthorizationHeader(
      buildChargeCredential(FULL, "ab", { source: "did:key:z6Mk" }),
    );

    expect(parseCredential(header).source).toBe("did:key:z6Mk");
  });
});

describe("buildSessionCredential", () => {
  it("builds each of the four actions", () => {
    const actions = [
      { action: "open" as const, preimage: "aa", returnInvoice: "lnbcrt1" },
      { action: "bearer" as const, sessionId: "7f3a" },
      { action: "topUp" as const, sessionId: "7f3a", topUpPreimage: "bb" },
      { action: "close" as const, sessionId: "7f3a", preimage: "aa" },
    ];

    for (const payload of actions) {
      const header = toAuthorizationHeader(
        buildSessionCredential(MINIMAL, payload),
      );
      const parsed = parseCredential<typeof payload>(header);

      expect(parsed.payload).toEqual(payload);
      expect(parsed.challenge.intent).toBe("session");
    }
  });
});
