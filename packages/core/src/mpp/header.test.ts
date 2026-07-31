import { describe, it, expect, beforeAll } from "vitest";
import {
  decodeRequestObject,
  encodeCredential,
  encodeRequestObject,
  formatAuthorizationHeader,
  formatChallengeHeader,
  parseChallengeHeader,
  parseCredential,
  parsePaymentChallenges,
  parseReceiptHeader,
  splitChallenges,
} from "./header.js";
import type {
  ChallengeParams,
  Credential,
  SessionReceipt,
} from "./types.js";
import {
  loadGoVectors,
  type ChallengeHeaderVector,
  type CredentialVector,
  type ReceiptVector,
} from "./goVectors.js";

let headerVectors: ChallengeHeaderVector[];
let credentialVectors: CredentialVector[];
let receiptVectors: ReceiptVector[];

beforeAll(async () => {
  const vectors = await loadGoVectors();
  headerVectors = vectors.challengeHeaders;
  credentialVectors = vectors.credentials;
  receiptVectors = vectors.receipts;
});

describe("challenge headers against Go reference vectors", () => {
  it("parses every header the reference emits", () => {
    for (const v of headerVectors) {
      const parsed = parseChallengeHeader(v.header);

      expect(parsed.id).toBe(v.params.ID);
      expect(parsed.realm).toBe(v.params.Realm);
      expect(parsed.method).toBe(v.params.Method);
      expect(parsed.intent).toBe(v.params.Intent);
      expect(parsed.request).toBe(v.params.Request);
      expect(parsed.expires ?? "").toBe(v.params.Expires);
      expect(parsed.digest ?? "").toBe(v.params.Digest);
      expect(parsed.description ?? "").toBe(v.params.Description);
      expect(parsed.opaque ?? "").toBe(v.params.Opaque);
    }
  });

  it("emits headers byte-identical to the reference", () => {
    for (const v of headerVectors) {
      expect(formatChallengeHeader(parseChallengeHeader(v.header))).toBe(
        v.header,
      );
    }
  });

  it("keeps a comma inside a description out of the parameter split", () => {
    const withComma = headerVectors.find(
      (v) => v.name === "description with spaces and comma",
    );

    expect(withComma).toBeDefined();
    expect(parseChallengeHeader(withComma!.header).description).toBe(
      "Weather report, hourly",
    );
  });
});

describe("credentials against Go reference vectors", () => {
  it("parses every credential header the reference emits", () => {
    for (const v of credentialVectors) {
      const parsed = parseCredential(v.header);
      expect(parsed).toEqual(JSON.parse(v.json));
    }
  });

  it("emits credential JSON byte-identical to the reference", () => {
    // Nothing signs these bytes, but matching the reference means a wire
    // capture from either side reads the same, which is what makes a
    // mismatched field obvious during integration.
    for (const v of credentialVectors) {
      const credential = JSON.parse(v.json) as Credential;
      expect(formatAuthorizationHeader(credential)).toBe(v.header);
    }
  });
});

describe("receipts against Go reference vectors", () => {
  it("parses every receipt the reference emits", () => {
    for (const v of receiptVectors) {
      expect(parseReceiptHeader(v.header)).toEqual(JSON.parse(v.json));
    }
  });

  it("reads the refund fields off a session close receipt", () => {
    const refunded = receiptVectors.find(
      (v) => v.name === "session close refunded",
    );
    const parsed = parseReceiptHeader<SessionReceipt>(refunded!.header);

    expect(parsed.refundSats).toBe(140);
    expect(parsed.refundStatus).toBe("succeeded");
  });

  it("reads a skipped refund, where the reference omits refundSats", () => {
    const skipped = receiptVectors.find(
      (v) => v.name === "session close skipped",
    );

    expect(skipped!.json).not.toContain("refundSats");

    const parsed = parseReceiptHeader<SessionReceipt>(skipped!.header);

    expect(parsed.refundStatus).toBe("skipped");
    expect(parsed.refundSats).toBeUndefined();
  });
});

describe("splitChallenges", () => {
  it("splits the comma-joined form the Fetch API produces", () => {
    // A server that offers two intents writes two WWW-Authenticate lines.
    // Headers.get() hands them back as one comma-joined string, so the
    // boundary between challenges has to be recovered from the scheme
    // tokens.
    const joined =
      'Payment id="charge-id", realm="api.example.com", ' +
      'method="lightning", intent="charge", request="eyJjIjoxfQ", ' +
      'Payment id="session-id", realm="api.example.com", ' +
      'method="lightning", intent="session", request="eyJzIjoxfQ"';

    const challenges = parsePaymentChallenges(joined);

    expect(challenges).toHaveLength(2);
    expect(challenges[0]?.intent).toBe("charge");
    expect(challenges[0]?.id).toBe("charge-id");
    expect(challenges[1]?.intent).toBe("session");
    expect(challenges[1]?.id).toBe("session-id");
  });

  it("ignores challenges under other schemes", () => {
    const mixed =
      'L402 macaroon="AQIDBA", invoice="lnbc100n1fake", ' +
      'Payment id="p", realm="r", method="lightning", intent="charge", ' +
      'request="eyJhIjoxfQ"';

    expect(splitChallenges(mixed).map((c) => c.scheme)).toEqual([
      "L402",
      "Payment",
    ]);
    expect(parsePaymentChallenges(mixed)).toHaveLength(1);
  });

  it("skips a malformed Payment challenge without losing a valid one", () => {
    // One unusable offer among several must not cost the client the offers
    // it could have satisfied.
    const mixed =
      'Payment id="broken", realm="r", ' +
      'Payment id="ok", realm="r", method="lightning", intent="charge", ' +
      'request="eyJhIjoxfQ"';

    const challenges = parsePaymentChallenges(mixed);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.id).toBe("ok");
  });

  it("does not split on a comma inside a quoted value", () => {
    const header =
      'Payment id="a", realm="r", method="lightning", intent="charge", ' +
      'request="eyJhIjoxfQ", description="one, two, three"';

    expect(parsePaymentChallenges(header)).toHaveLength(1);
    expect(parseChallengeHeader(header).description).toBe("one, two, three");
  });

  it("accepts the scheme name case-insensitively", () => {
    const header =
      'payment id="a", realm="r", method="lightning", intent="charge", ' +
      'request="eyJhIjoxfQ"';

    expect(parseChallengeHeader(header).id).toBe("a");
  });

  it("accepts unquoted token values and whitespace around equals", () => {
    const header =
      'Payment  id = "a" ,  realm = "r" , method=lightning, ' +
      "intent=charge, request=eyJhIjoxfQ";

    const parsed = parseChallengeHeader(header);
    expect(parsed.method).toBe("lightning");
    expect(parsed.intent).toBe("charge");
    expect(parsed.request).toBe("eyJhIjoxfQ");
  });

  it("resolves backslash escapes inside a quoted value", () => {
    // The value must come back as the server had it before quoting, since
    // the echoed credential is what the server recomputes its HMAC over.
    const params: ChallengeParams = {
      id: "a",
      realm: 'realm "with" quotes',
      method: "lightning",
      intent: "charge",
      request: "eyJhIjoxfQ",
    };

    const header = formatChallengeHeader(params);
    expect(header).toContain('realm="realm \\"with\\" quotes"');
    expect(parseChallengeHeader(header).realm).toBe('realm "with" quotes');
  });

  it("takes the first occurrence of a duplicated parameter", () => {
    // A parameter appended after the fact must not displace the one the
    // server's HMAC covered.
    const header =
      'Payment id="first", realm="r", method="lightning", ' +
      'intent="charge", request="eyJhIjoxfQ", id="second"';

    expect(parseChallengeHeader(header).id).toBe("first");
  });
});

describe("parseChallengeHeader errors", () => {
  const cases: Array<[string, string]> = [
    ["wrong scheme", 'Bearer token="abc"'],
    ["empty value", ""],
    [
      "missing id",
      'Payment realm="r", method="lightning", intent="charge", request="a"',
    ],
    [
      "missing realm",
      'Payment id="1", method="lightning", intent="charge", request="a"',
    ],
    [
      "missing method",
      'Payment id="1", realm="r", intent="charge", request="a"',
    ],
    [
      "missing intent",
      'Payment id="1", realm="r", method="lightning", request="a"',
    ],
    [
      "missing request",
      'Payment id="1", realm="r", method="lightning", intent="charge"',
    ],
    [
      "empty required value",
      'Payment id="", realm="r", method="lightning", intent="charge", ' +
        'request="a"',
    ],
  ];

  it.each(cases)("rejects %s", (_name, header) => {
    expect(() => parseChallengeHeader(header)).toThrow();
  });
});

describe("parseCredential errors", () => {
  function encode(json: string): string {
    return `Payment ${encodeRequestObjectRaw(json)}`;
  }

  function encodeRequestObjectRaw(json: string): string {
    return Buffer.from(json, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  const cases: Array<[string, string]> = [
    ["wrong scheme", "Bearer abc123"],
    ["empty token", "Payment "],
    ["invalid base64", "Payment !!!!"],
    ["invalid json", encode("{invalid}")],
    ["not an object", encode('"a string"')],
    ["missing challenge", encode('{"payload":{}}')],
    [
      "missing challenge.id",
      encode(
        '{"challenge":{"realm":"r","method":"lightning","intent":"charge",' +
          '"request":"a"},"payload":{}}',
      ),
    ],
    [
      "missing challenge.request",
      encode(
        '{"challenge":{"id":"1","realm":"r","method":"lightning",' +
          '"intent":"charge"},"payload":{}}',
      ),
    ],
    [
      "missing payload",
      encode(
        '{"challenge":{"id":"1","realm":"r","method":"lightning",' +
          '"intent":"charge","request":"a"}}',
      ),
    ],
  ];

  it.each(cases)("rejects %s", (_name, header) => {
    expect(() => parseCredential(header)).toThrow(/mpp:/);
  });

  it("rejects an oversized credential before decoding it", () => {
    const huge = `Payment ${"A".repeat(120_000)}`;
    expect(() => parseCredential(huge)).toThrow(/credential too large/);
  });
});

describe("request objects", () => {
  it("round-trips a charge request through the wire encoding", () => {
    const request = {
      amount: "100",
      currency: "sat",
      methodDetails: {
        invoice: "lnbc1u1p...",
        paymentHash: "bc230847...",
        network: "mainnet",
      },
    };

    const encoded = encodeRequestObject(request);
    expect(encoded).not.toContain("=");
    expect(decodeRequestObject(encoded)).toEqual(request);
  });

  it("is deterministic regardless of property order", () => {
    expect(encodeRequestObject({ b: "2", a: "1" })).toBe(
      encodeRequestObject({ a: "1", b: "2" }),
    );
  });

  it("rejects a request parameter that is not valid base64url", () => {
    expect(() => decodeRequestObject("!!!!")).toThrow(/failed to decode/);
  });

  it("rejects a request parameter whose bytes are not JSON", () => {
    expect(() => decodeRequestObject(encodeRequestObject("x").slice(0, 2)))
      .toThrow(/mpp:/);
  });
});

describe("encodeCredential", () => {
  it("omits an unset source rather than emitting null", () => {
    // The DID payer identifier is left unpopulated on purpose. An explicit
    // null would still be a field the seller can key on.
    const encoded = encodeCredential({
      challenge: {
        id: "a",
        realm: "r",
        method: "lightning",
        intent: "charge",
        request: "eyJhIjoxfQ",
      },
      payload: { preimage: "ab" },
    });

    expect(parseCredential(`Payment ${encoded}`)).not.toHaveProperty("source");
    expect(Buffer.from(encoded, "base64url").toString()).not.toContain(
      "source",
    );
  });

  it("omits challenge fields the server did not send", () => {
    const encoded = encodeCredential({
      challenge: {
        id: "a",
        realm: "r",
        method: "lightning",
        intent: "charge",
        request: "eyJhIjoxfQ",
      },
      payload: { preimage: "ab" },
    });

    const json = Buffer.from(encoded, "base64url").toString();
    expect(json).not.toContain("expires");
    expect(json).not.toContain("opaque");
    expect(json).not.toContain("digest");
  });
});
