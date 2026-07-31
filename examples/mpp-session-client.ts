/**
 * Example buyer for the Machine Payments Protocol's session intent.
 *
 * Usage: npx tsx examples/mpp-session-client.ts
 *
 * Prerequisites: an aperture proxy configured to answer with
 * `WWW-Authenticate: Payment ... intent="session"`, reachable at SELLER_URL.
 *
 * The point of a session is that only the first call touches the wallet.
 * The deposit buys a balance, every request after it rides a bearer
 * credential for free, and the close hands the unspent remainder back.
 */

import {
  createPayingFetch,
  MockInvoicePayer,
  MockReturnInvoiceMinter,
  SessionCache,
} from "@aperture/client";
import { BudgetCapPolicy } from "@aperture/core/policy";

const SELLER_URL = process.env.SELLER_URL ?? "http://localhost:8081/v1/infer";

// In production both of these come from a real wallet. The payer settles
// invoices; the minter produces the amountless invoice the server pays the
// unspent balance back to when the session closes. They are separate
// capabilities, and a wallet that cannot do the second one should not open
// sessions: the deposit would have nowhere to come back to.
const payer = new MockInvoicePayer();
const returnInvoiceMinter = new MockReturnInvoiceMinter();

// Sessions hold real money between requests. This one is process-local, so
// a restart forgets the session id and with it the refund. Anything running
// longer than a script wants a durable store here.
const sessionStore = new SessionCache();

const payingFetch = createPayingFetch({
  payer,

  // Under a session the policy is asserted on the deposit, not per request,
  // because that is where the money actually moves.
  buyerPolicy: new BudgetCapPolicy(10_000),

  mpp: {
    returnInvoiceMinter,
    sessionStore,

    // Prefer a session, fall back to a one-shot charge if the server does
    // not offer one.
    intents: ["session", "charge"],
  },
});

const PROMPTS = [
  "Summarize the Lightning Network in one sentence.",
  "Now do it in two.",
  "Now explain it to a cat.",
];

async function main(): Promise<void> {
  for (const prompt of PROMPTS) {
    const response = await payingFetch(SELLER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    console.log(`${response.status} ${prompt}`);
    if (!response.ok) {
      console.log(await response.text());
      break;
    }
  }

  const session = await payingFetch.sessions.findForOrigin(
    new URL(SELLER_URL).origin,
  );
  if (session !== null) {
    console.log(
      `session ${session.sessionId}: deposited ${session.depositedSat} sat, ` +
        `roughly ${payingFetch.sessions.remainingSat(session)} sat left`,
    );
  }

  // Close on the way out. Nothing else will: a session the client walks
  // away from sits with the seller until its idle timeout.
  for (const outcome of await payingFetch.closeSessions()) {
    console.log(
      `closed ${outcome.record.sessionId}: refund ${outcome.refundSats} sat ` +
        `(${outcome.refundStatus})`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
