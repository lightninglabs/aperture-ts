/**
 * Emit a buyer transcript from the TypeScript implementation, for
 * verify_transcript.go to check as the seller would.
 *
 * Run against built output, from this directory:
 *
 *     pnpm -r build && node emit_transcript.mjs > transcript.json
 *
 * See README.md.
 */

import {
  computeChallengeId,
  encodeRequestObject,
  formatChallengeHeader,
  canonicalizeJson,
} from "../../dist/mpp/index.js";
import {
  buildChargeCredential,
  buildSessionCredential,
  toAuthorizationHeader,
} from "../../../client/dist/index.js";

const SECRET = "test-server-secret-key-32-bytes!";

async function sign(params) {
  const unsigned = { ...params };
  return { id: await computeChallengeId(SECRET, unsigned), ...unsigned };
}

const transcript = [];

// A charge challenge, and the credential a buyer answers it with.
const chargeRequest = {
  amount: "100",
  currency: "sat",
  description: "Weather report, hourly & <fresh>",
  methodDetails: {
    invoice: "lnbc1u1pexample",
    paymentHash: "bc230847abcdef",
    network: "regtest",
  },
};
const charge = await sign({
  realm: "api.example.com",
  method: "lightning",
  intent: "charge",
  request: encodeRequestObject(chargeRequest),
  expires: "2099-03-15T12:05:00Z",
  description: "Weather report, hourly",
});
transcript.push({
  name: "charge",
  secret: SECRET,
  wwwAuthenticate: formatChallengeHeader(charge),
  authorization: toAuthorizationHeader(
    buildChargeCredential(charge, "a3".repeat(32)),
  ),
  expectPayload: { preimage: "a3".repeat(32) },
});

// A session challenge, and each of the four credential actions.
const sessionRequest = {
  amount: "2",
  currency: "sat",
  description: "LLM token stream",
  unitType: "token",
  depositInvoice: "lnbcrt3u1pexample",
  paymentHash: "7f3a1b2c4d5e6f",
  depositAmount: "300",
  idleTimeout: "300",
};
const session = await sign({
  realm: "api.example.com",
  method: "lightning",
  intent: "session",
  request: encodeRequestObject(sessionRequest),
  opaque: encodeRequestObject({ tenant: "acme", tier: "gold" }),
});

const actions = [
  { action: "open", preimage: "aa".repeat(32), returnInvoice: "lnbcrt1refund" },
  { action: "bearer", sessionId: "7f3a1b2c4d5e6f" },
  { action: "topUp", sessionId: "7f3a1b2c4d5e6f", topUpPreimage: "bb".repeat(32) },
  { action: "close", sessionId: "7f3a1b2c4d5e6f", preimage: "aa".repeat(32) },
];

for (const payload of actions) {
  transcript.push({
    name: `session ${payload.action}`,
    secret: SECRET,
    wwwAuthenticate: formatChallengeHeader(session),
    authorization: toAuthorizationHeader(
      buildSessionCredential(session, payload),
    ),
    expectPayload: payload,
  });
}

// A challenge with characters that exercise header quoting and JCS escaping.
const awkward = await sign({
  realm: "api.example.com",
  method: "lightning",
  intent: "charge",
  request: encodeRequestObject({
    amount: "1",
    currency: "sat",
    description: "a & b < c > d   café 中",
    methodDetails: { invoice: "lnbc10n1awkward" },
  }),
  expires: "2099-01-01T00:00:00Z",
});
transcript.push({
  name: "awkward strings",
  secret: SECRET,
  wwwAuthenticate: formatChallengeHeader(awkward),
  authorization: toAuthorizationHeader(
    buildChargeCredential(awkward, "cc".repeat(32)),
  ),
  expectPayload: { preimage: "cc".repeat(32) },
});

// Canonical forms the Go side re-canonicalizes to check byte agreement.
const canonical = [
  '{"z":1,"a":2,"m":{"y":true,"x":null}}',
  '{"s":"a & b < c > d"}',
  '{"list":[3,2,1],"nested":{"k":"v"}}',
  '{"amount":"100","currency":"sat"}',
].map((input) => ({ input, canonical: canonicalizeJson(input) }));

process.stdout.write(
  JSON.stringify({ transcript, canonical }, null, 2) + "\n",
);
