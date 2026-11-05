/**
 * Emit a session-lifecycle transcript from the TypeScript buyer, for
 * verify_session_transcript.go to drive through the reference session
 * authenticator.
 *
 * Where emit_transcript.mjs proves the codecs agree byte for byte, this
 * proves the *state machine* agrees: the credentials a real `payingFetch`
 * run produces for open, bearer, top-up, and close are replayed in Go
 * against `auth.MPPSessionAuthenticator`, which is the component that
 * decides whether a session ever exists and whether its deposit ever comes
 * back. A client that pays the deposit but never convinces that
 * authenticator has lost the money, so this is the transcript that guards
 * the expensive direction.
 *
 * Run against built output, from this directory:
 *
 *     pnpm -r build && node emit_session_transcript.mjs > session_transcript.json
 *
 * See README.md for the Go half.
 */

import { createHash } from "node:crypto";
import {
  computeChallengeId,
  encodeRequestObject,
  formatChallengeHeader,
  PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE,
} from "../../dist/mpp/index.js";
import { createPayingFetch } from "../../../client/dist/index.js";

const SECRET = "test-server-secret-key-32-bytes!";
const REALM = "api.example.com";
const URL_UNDER_TEST = "https://api.example.com/infer";

const DEPOSIT_PREIMAGE = "aa".repeat(32);
const TOPUP_PREIMAGE = "bb".repeat(32);

// A real amountless BOLT11 regtest invoice with a ten-year expiry, because
// the reference authenticator zpay32-decodes the return invoice and refuses
// an open whose refund path it cannot parse. Regenerate with lnd's zpay32
// if it ever ages out (timestamp 2026-01-01, expiry 10 years).
const RETURN_INVOICE =
  "lnbcrt1p54twgqpp5382dcnjpvpw0jyw5mnnw37se7kyxsskrpjysng6ddqdmxgsef5ksdp2" +
  "v9cx2un5w4ex2tt5wvs8xetnwd5k7m3qwfjkvatwvsxqxfvcqcqc9van6xxqrmg5nmglzj04" +
  "6cap8mnyvhvdtsnd2drn9922zy8zp8qtg7g33e5wdy80xpfysp3xag0sgvfjs87v927zyd3q" +
  "dfah0x8ryqqxfc82q";

function sha256hex(hex) {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

async function sign(params) {
  return { id: await computeChallengeId(SECRET, params), ...params };
}

const openChallenge = await sign({
  realm: REALM,
  method: "lightning",
  intent: "session",
  request: encodeRequestObject({
    amount: "2",
    currency: "sat",
    unitType: "token",
    depositInvoice: "lnbcrt3u1pdeposit",
    paymentHash: sha256hex(DEPOSIT_PREIMAGE),
    depositAmount: "300",
    idleTimeout: "300",
  }),
});

const topUpChallenge = await sign({
  realm: REALM,
  method: "lightning",
  intent: "session",
  request: encodeRequestObject({
    amount: "2",
    currency: "sat",
    unitType: "token",
    depositInvoice: "lnbcrt5u1ptopup",
    paymentHash: sha256hex(TOPUP_PREIMAGE),
    depositAmount: "500",
    idleTimeout: "300",
  }),
});

function challengeResponse(challenge, problem) {
  const headers = new Headers({
    "WWW-Authenticate": formatChallengeHeader(challenge),
  });
  if (problem === undefined) {
    return new Response(null, { status: 402, headers });
  }
  headers.set("Content-Type", "application/problem+json");
  return new Response(JSON.stringify({ type: problem, status: 402 }), {
    status: 402,
    headers,
  });
}

/** The exchanges the buyer produced, in the order it produced them. */
const exchanges = [];

function record(name, authorization) {
  exchanges.push({ name, authorization, expectAccept: true });
}

// A scripted seller: the client sees an open offer, serves the handshake and
// two bearer requests, reports an empty balance, takes the top-up, and then
// serves the bearer that follows it.
let calls = 0;
globalThis.fetch = async (input) => {
  const request = new Request(input);
  const authorization = request.headers.get("Authorization");
  calls += 1;

  if (authorization === null) return challengeResponse(openChallenge);

  const payload = JSON.parse(
    Buffer.from(authorization.slice("Payment ".length), "base64url")
      .toString(),
  ).payload;

  switch (payload.action) {
    case "open":
      record("open", authorization);
      return new Response("ok", { status: 200 });

    case "bearer":
      if (calls === 4) {
        // The second bearer request finds the balance spent.
        return challengeResponse(
          topUpChallenge,
          PROBLEM_LIGHTNING_INSUFFICIENT_BALANCE,
        );
      }
      record(calls === 3 ? "bearer" : "bearer after topUp", authorization);
      return new Response("ok", { status: 200 });

    case "topUp":
      record("topUp", authorization);
      return new Response("ok", { status: 200 });

    default:
      throw new Error(`unexpected action ${payload.action}`);
  }
};

const payer = {
  async payInvoice({ invoice, amountSat }) {
    if (invoice === "lnbcrt3u1pdeposit") {
      return { preimageHex: DEPOSIT_PREIMAGE, amountPaidSat: amountSat };
    }
    if (invoice === "lnbcrt5u1ptopup") {
      return { preimageHex: TOPUP_PREIMAGE, amountPaidSat: amountSat };
    }
    throw new Error(`no preimage for ${invoice}`);
  },
};

const client = createPayingFetch({
  payer,
  mpp: {
    returnInvoiceMinter: {
      async mintAmountlessInvoice() {
        return { invoice: RETURN_INVOICE };
      },
    },
  },
});

// Open on the first call, bearer on the second, top-up on the third, and a
// bearer echoing the top-up challenge on the fourth.
for (let i = 0; i < 4; i++) {
  const response = await client(URL_UNDER_TEST);
  if (response.status !== 200) {
    throw new Error(`call ${i} came back ${response.status}`);
  }
}

// Close and collect the refund credential.
await client.closeSessions(async ({ authorization }) => {
  record("close", authorization);
  return new Response("ok", { status: 200 });
});

process.stdout.write(
  JSON.stringify(
    {
      secret: SECRET,
      realm: REALM,
      returnInvoice: RETURN_INVOICE,
      exchanges,
    },
    null,
    2,
  ) + "\n",
);
