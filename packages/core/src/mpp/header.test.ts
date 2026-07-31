import { describe, it, expect, beforeAll } from "vitest";
import {
  decodeRequestObject,
  encodeCredential,
  encodeReceipt,
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
  Receipt,
  SessionReceipt,
} from "./types.js";
import {
  loadGoVectors,
  type ChallengeHeaderVector,
  type ChallengeListVector,
  type CredentialVector,
  type ReceiptVector,
} from "./goVectors.js";
import { decodeBase64UrlText } from "./base64url.js";

let headerVectors: ChallengeHeaderVector[];
let listVectors: ChallengeListVector[];
let credentialVectors: CredentialVector[];
let receiptVectors: ReceiptVector[];

beforeAll(async () => {
  const vectors = await loadGoVectors();
  headerVectors = vectors.challengeHeaders;
  listVectors = vectors.challengeLists;
  credentialVectors = vectors.credentials;
  receiptVectors = vectors.receipts;
});

/**
 * Whether a JSON document holds an integer JavaScript cannot represent
 * exactly.
 *
 * The vector file deliberately carries a few, because the peer is Go and an
 * int64 goes places a double does not. Parsing one is lossy in either
 * direction and both sides know it; re-emitting one is where the loss
 * becomes visible, so the emission checks below skip exactly those and this
 * predicate is what they skip on.
 */
function hasUnsafeInteger(json: string): boolean {
  for (const match of json.matchAll(/-?\d{16,}/g)) {
    if (!Number.isSafeInteger(Number(match[0]))) return true;
  }
  return false;
}

describe("challenge headers against the Go vector file", () => {
  it("loads a non-trivial vector set", () => {
    expect(headerVectors.length).toBeGreaterThan(0);
  });

  it("parses every header the reference emits", () => {
    for (const v of headerVectors) {
      expect(parseChallengeHeader(v.header)).toEqual(v.parsed);
    }
  });

  it("emits headers byte-identical to the reference", () => {
    for (const v of headerVectors) {
      expect(formatChallengeHeader(v.params as ChallengeParams)).toBe(
        v.header,
      );
    }
  });

  it("round-trips a value the grammar has to escape", () => {
    // A quotation mark or a reverse solidus inside a parameter is written
    // escaped and has to come back unescaped, or the credential echoes
    // something the server never signed.
    for (const name of [
      "quotation mark in a parameter",
      "reverse solidus in a parameter",
    ]) {
      const v = headerVectors.find((entry) => entry.name === name);
      expect(v, name).toBeDefined();
      expect(parseChallengeHeader(v!.header)).toEqual(v!.params);
    }
  });

  it("keeps a separator inside a quoted value out of the parse", () => {
    // A description carrying a comma, an equals sign, or something that
    // looks like the start of another challenge must not split the header.
    const v = headerVectors.find(
      (entry) => entry.name === "separators inside a parameter",
    );

    expect(v).toBeDefined();
    expect(parseChallengeHeader(v!.header).realm).toBe("one, two=three");
    expect(parseChallengeHeader(v!.header).description).toBe(
      'Payment id="spoofed"',
    );
  });
});

describe("challenge lists against the Go vector file", () => {
  it("loads both parseable and unusable cases", () => {
    expect(listVectors.some((v) => v.error === true)).toBe(true);
    expect(listVectors.some((v) => (v.challenges ?? []).length > 1)).toBe(true);
  });

  it("recovers every challenge the reference recovers, in order", () => {
    const mismatches = listVectors
      .filter((v) => v.error !== true)
      .map((v) => ({
        name: v.name,
        want: v.challenges ?? [],
        got: parsePaymentChallenges(v.header),
      }))
      .filter((m) => JSON.stringify(m.want) !== JSON.stringify(m.got));

    expect(mismatches).toEqual([]);
  });

  it("finds nothing in a value the reference calls unusable", () => {
    for (const v of listVectors) {
      if (v.error !== true) continue;
      expect(parsePaymentChallenges(v.header), v.name).toEqual([]);
    }
  });
});

describe("credentials against the Go vector file", () => {
  it("loads both accepted and rejected cases", () => {
    expect(credentialVectors.some((v) => v.error === true)).toBe(true);
  });

  it("parses every credential header the reference emits", () => {
    for (const v of credentialVectors) {
      if (v.error === true) continue;
      expect(parseCredential(v.header), v.name).toEqual(
        JSON.parse(v.credentialJson),
      );
    }
  });

  it("rejects every credential header the reference rejects", () => {
    const accepted = credentialVectors
      .filter((v) => v.error === true)
      .filter((v) => {
        try {
          parseCredential(v.header);
          return true;
        } catch {
          return false;
        }
      })
      .map((v) => v.name);

    expect(accepted).toEqual([]);
  });

  it("emits credential JSON byte-identical to the reference", () => {
    // Nothing signs these bytes, but matching the reference means a wire
    // capture from either side reads the same, which is what makes a
    // mismatched field obvious during integration.
    //
    // Two vectors are left out. One spells the scheme token in lowercase to
    // exercise the parser, and is not a statement about what an emitter
    // produces. The other is the subject of the next test.
    let checked = 0;

    for (const v of credentialVectors) {
      if (v.error === true) continue;
      if (!v.header.startsWith("Payment ")) continue;

      const credential = JSON.parse(v.credentialJson) as Credential;
      expect(formatAuthorizationHeader(credential), v.name).toBe(v.header);
      checked += 1;
    }

    expect(checked).toBeGreaterThan(1);
  });

  it("does not escape HTML characters inside a credential either", () => {
    // This used to be the one place the two sides disagreed on bytes. The
    // reference's canonicalizer had stopped escaping "<", ">" and "&", but
    // its credential encoder was a plain json.Marshal and still did, so a
    // credential echoing a description like "Q&A endpoint" came out spelled
    // two ways.
    //
    // The reference now routes both the credential and the receipt through an
    // encoder with HTML escaping off, and gained an EncodeCredential to sit
    // opposite its parser. Nothing signs a credential, so this was never a
    // security question, but a vector pinning the wrong bytes is how the next
    // implementation inherits the bug. The agreement is asserted rather than
    // the divergence documented.
    const v = credentialVectors.find(
      (entry) => entry.name === "session open credential with a source",
    );
    expect(v).toBeDefined();
    expect(v!.credentialJson).toContain("Q&A endpoint");
    expect(v!.credentialJson).not.toContain("\\u0026");

    const credential = JSON.parse(v!.credentialJson) as Credential;
    const emitted = formatAuthorizationHeader(credential);

    expect(emitted).toBe(v!.header);
    expect(
      decodeBase64UrlText(emitted.slice("Payment ".length)),
    ).toContain("Q&A endpoint");
    expect(parseCredential(emitted)).toEqual(parseCredential(v!.header));
  });
});

describe("receipts against the Go vector file", () => {
  it("loads a non-trivial vector set", () => {
    expect(receiptVectors.length).toBeGreaterThan(0);
  });

  it("decodes every header to the document the reference encoded", () => {
    // Not every vector in this group is a receipt: the mid-stream top-up
    // event travels the same way and is checked the same way, as bytes.
    for (const v of receiptVectors) {
      expect(
        JSON.parse(decodeBase64UrlText(v.header)),
        v.name,
      ).toEqual(JSON.parse(v.receiptJson));
    }
  });

  it("parses every receipt the reference emits", () => {
    for (const v of receiptVectors) {
      const document = JSON.parse(v.receiptJson) as Record<string, unknown>;
      if (document.status === undefined) continue;

      expect(parseReceiptHeader(v.header), v.name).toEqual(document);
    }
  });

  it("reads the refund fields off a session close receipt", () => {
    const refunded = receiptVectors.find(
      (v) => v.name === "session close with a refund",
    );
    const parsed = parseReceiptHeader<SessionReceipt>(refunded!.header);

    expect(parsed.refundSats).toBe(140);
    expect(parsed.refundStatus).toBe("succeeded");
  });

  it("reads a skipped refund, where the reference omits refundSats", () => {
    const skipped = receiptVectors.find(
      (v) => v.name === "session close with nothing to refund",
    );

    expect(skipped!.receiptJson).not.toContain("refundSats");

    const parsed = parseReceiptHeader<SessionReceipt>(skipped!.header);

    expect(parsed.refundStatus).toBe("skipped");
    expect(parsed.refundSats).toBeUndefined();
  });

  it("emits receipt headers byte-identical to the reference", () => {
    // The two receipt structs the reference declares do not agree on field
    // order, so reproducing the bytes means reproducing both orders. The
    // charge vectors are the base receipt; the close vectors are the session
    // receipt.
    //
    // The vectors carrying an int64 past 2^53 are left out. A double cannot
    // hold one, so this side reads it as the nearest representable value and
    // re-emits that, which is a lossy round trip rather than a disagreement
    // about the format. The check below pins where that starts.
    let checked = 0;

    for (const v of receiptVectors) {
      const document = JSON.parse(v.receiptJson) as Record<string, unknown>;
      if (document.status === undefined) continue;
      if (hasUnsafeInteger(v.receiptJson)) continue;

      expect(encodeReceipt(document as unknown as Receipt), v.name).toBe(
        v.header,
      );
      checked += 1;
    }

    expect(checked).toBeGreaterThan(2);
  });

  it("cannot re-emit a refund larger than a double can hold", () => {
    // Worth stating rather than skipping in silence. Every amount the
    // protocol itself defines travels as a decimal string for exactly this
    // reason; `refundSats` is the one place a raw JSON integer reaches a
    // JavaScript client, and past 2^53 it arrives rounded.
    const huge = receiptVectors.find(
      (v) => v.name === "largest refund an int64 can hold",
    );

    expect(huge).toBeDefined();
    const parsed = parseReceiptHeader<SessionReceipt>(huge!.header);

    expect(parsed.refundSats).toBe(9223372036854775807);
    expect(Number.isSafeInteger(parsed.refundSats as number)).toBe(false);
    expect(encodeReceipt(parsed)).not.toBe(huge!.header);
  });

  it("does not let the caller's property order reach the wire", () => {
    // JSON.stringify would follow insertion order, which would make the
    // bytes depend on how the seller happened to build the object.
    const refunded = receiptVectors.find(
      (v) => v.name === "session close with a refund",
    );
    const receipt = JSON.parse(refunded!.receiptJson) as SessionReceipt;

    const scrambled: SessionReceipt = {
      refundStatus: receipt.refundStatus as SessionReceipt["refundStatus"],
      timestamp: receipt.timestamp,
      status: receipt.status,
      refundSats: receipt.refundSats as number,
      reference: receipt.reference,
      method: receipt.method,
    };

    expect(encodeReceipt(scrambled)).toBe(refunded!.header);
  });

  it("carries a field the reference does not declare rather than dropping it", () => {
    const encoded = encodeReceipt({
      status: "success",
      method: "lightning",
      timestamp: "2026-03-10T21:00:00Z",
      reference: "bc230847",
      settledBy: "somebody",
    } as Receipt & { settledBy: string });

    expect(JSON.parse(Buffer.from(encoded, "base64url").toString())).toEqual({
      status: "success",
      method: "lightning",
      timestamp: "2026-03-10T21:00:00Z",
      reference: "bc230847",
      settledBy: "somebody",
    });
  });

  it("refuses a receipt claiming a status the protocol does not define", () => {
    // The protocol defines exactly one status, and a receipt is the only
    // thing a client keeps as evidence that a payment settled. One that
    // says "failed" is evidence of the opposite.
    const failed = Buffer.from(
      JSON.stringify({
        status: "failed",
        method: "lightning",
        timestamp: "2026-03-10T21:00:00Z",
        reference: "bc230847",
      }),
    ).toString("base64url");

    expect(() => parseReceiptHeader(failed)).toThrow(
      /receipt status is "failed"/,
    );
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
