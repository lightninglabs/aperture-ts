import { describe, it, expect, vi } from "vitest";
import type { BuyerPolicy } from "@lightninglabs/aperture-core";
import { SessionCache, type SessionRecord } from "../cache/sessionStore.js";
import { ReceiptCache } from "../cache/receiptCache.js";
import { paymentChallengesFromHeaders } from "./challenge.js";
import type { SessionChallenge } from "./challenge.js";
import { SessionManager } from "./sessionManager.js";
import { MockReturnInvoiceMinter } from "./mockMinter.js";
import {
  ScriptedPayer,
  challengeResponse,
  hashFor,
  invoiceFor,
  preimageFor,
  receiptResponse,
  sessionChallenge,
} from "./fixtures.js";

const ORIGIN = "https://api.example.com";
const URL_UNDER_TEST = `${ORIGIN}/infer`;

async function offer(options: {
  depositSat: number;
  pricePerUnitSat?: number;
  label: string;
  expires?: string;
  withoutDepositInvoice?: boolean;
}): Promise<SessionChallenge> {
  const params = await sessionChallenge({
    depositSat: options.depositSat,
    pricePerUnitSat: options.pricePerUnitSat ?? 2,
    label: options.label,
    ...(options.expires === undefined ? {} : { expires: options.expires }),
    ...(options.withoutDepositInvoice === undefined
      ? {}
      : { withoutDepositInvoice: options.withoutDepositInvoice }),
  });

  const challenge = paymentChallengesFromHeaders(challengeResponse([params]))[0];
  if (challenge?.intent !== "session") throw new Error("not a session offer");
  return challenge;
}

function newManager(overrides: Partial<{
  payer: ScriptedPayer;
  minter: MockReturnInvoiceMinter | undefined;
  buyerPolicy: BuyerPolicy;
  store: SessionCache;
  receiptStore: ReceiptCache;
  allowSessionWithoutRefund: boolean;
  minUnitsRemaining: number;
}> = {}) {
  const payer = overrides.payer ?? new ScriptedPayer();
  const store = overrides.store ?? new SessionCache();
  const receiptStore = overrides.receiptStore ?? new ReceiptCache();
  const minter =
    "minter" in overrides ? overrides.minter : new MockReturnInvoiceMinter();

  const manager = new SessionManager({
    payer,
    store,
    receiptStore,
    ...(minter === undefined ? {} : { minter }),
    ...(overrides.buyerPolicy === undefined
      ? {}
      : { buyerPolicy: overrides.buyerPolicy }),
    ...(overrides.allowSessionWithoutRefund === undefined
      ? {}
      : { allowSessionWithoutRefund: overrides.allowSessionWithoutRefund }),
    ...(overrides.minUnitsRemaining === undefined
      ? {}
      : { minUnitsRemaining: overrides.minUnitsRemaining }),
  });

  return { manager, payer, store, receiptStore, minter };
}

/**
 * Acknowledge a session's outstanding handshake, standing in for the paying
 * fetch presenting it and the server accepting it.
 */
async function acknowledgeHandshake(
  manager: SessionManager,
  record: SessionRecord,
): Promise<void> {
  const presentation = await manager.credentialForRequest(record);
  await manager.reportPresentation(presentation, { ok: true, status: 200 });
}

async function openOne(options: {
  depositSat?: number;
  label?: string;
} = {}) {
  const depositSat = options.depositSat ?? 300;
  const label = options.label ?? "deposit";

  const fixtures = newManager();
  await fixtures.payer.expectLabel(depositSat, label);

  const challenge = await offer({ depositSat, label });
  const key = SessionManager.key(ORIGIN, challenge.params.realm);
  const record = await fixtures.manager.open({
    key,
    origin: ORIGIN,
    url: URL_UNDER_TEST,
    challenge,
  });
  await acknowledgeHandshake(fixtures.manager, record);

  return { ...fixtures, challenge, key, record, depositSat, label };
}

describe("opening a session", () => {
  it("derives the session id from the preimage, not the challenge", async () => {
    const { record, label } = await openOne({ label: "derive" });
    expect(record.sessionId).toBe(await hashFor(label));
  });

  it("records the deposit, the price, and the return invoice", async () => {
    const { record, minter } = await openOne({ depositSat: 300 });

    expect(record.depositedSat).toBe(300);
    expect(record.spentEstimateSat).toBe(0);
    expect(record.pricePerUnitSat).toBe(2);
    expect(record.returnInvoice).toBe(minter?.minted[0]);
    expect(record.openUrl).toBe(URL_UNDER_TEST);
  });

  it("keeps the deposit preimage, which the close credential needs", async () => {
    const { record, label } = await openOne({ label: "close-proof" });
    expect(record.depositPreimage).toBe(preimageFor(label));
  });

  it("writes the deposit to the payment ledger", async () => {
    const { receiptStore, record, depositSat } = await openOne();
    const entry = receiptStore.get(record.sessionId);

    expect(entry?.amountSat).toBe(depositSat);
    expect(entry?.preimageHex).toBe(record.depositPreimage);
  });

  it("keeps the session when the payment ledger refuses the write", async () => {
    // The deposit has settled by the time the ledger is asked. A gap in the
    // audit trail is bad; throwing the session away, and the refund with
    // it, over a failed audit write would be worse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payer = new ScriptedPayer();
    await payer.expectLabel(300, "noledger");

    const manager = new SessionManager({
      payer,
      store: new SessionCache(),
      minter: new MockReturnInvoiceMinter(),
      receiptStore: {
        store() {
          throw new Error("ledger offline");
        },
      },
    });

    const record = await manager.open({
      key: "k",
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge: await offer({ depositSat: 300, label: "noledger" }),
    });

    expect(record.depositedSat).toBe(300);
    expect(await manager.get("k")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("asserts the buyer policy on the whole deposit", async () => {
    // Under a session the money moves at open, not per request, so the
    // policy has to see the deposit rather than the price of the request
    // that happened to trigger it.
    const assertAllowed = vi.fn(async (_input: unknown) => {});
    const { manager, payer } = newManager({ buyerPolicy: { assertAllowed } });
    await payer.expectLabel(300, "policy");

    const challenge = await offer({ depositSat: 300, label: "policy" });
    await manager.open({
      key: "k",
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    expect(assertAllowed).toHaveBeenCalledTimes(1);
    expect(assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ amountSat: 300, host: "api.example.com" }),
    );
  });

  it("does not pay when the policy rejects the deposit", async () => {
    const { manager, payer, store } = newManager({
      buyerPolicy: {
        assertAllowed: async () => {
          throw new Error("over budget");
        },
      },
    });
    await payer.expectLabel(300, "rejected");

    const challenge = await offer({ depositSat: 300, label: "rejected" });
    await expect(
      manager.open({
        key: "k",
        origin: ORIGIN,
        url: URL_UNDER_TEST,
        challenge,
      }),
    ).rejects.toThrow(/over budget/);

    expect(payer.paid).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("refuses a session it cannot get a refund out of", async () => {
    // Without a return invoice every unspent satoshi stays with the seller,
    // so the failure belongs before the deposit rather than after it.
    const { manager, payer } = newManager({ minter: undefined });
    await payer.expectLabel(300, "norefund");

    const challenge = await offer({ depositSat: 300, label: "norefund" });
    await expect(
      manager.open({
        key: "k",
        origin: ORIGIN,
        url: URL_UNDER_TEST,
        challenge,
      }),
    ).rejects.toThrow(/would forfeit the unspent deposit/);

    expect(payer.paid).toEqual([]);
  });

  it("opens without a refund path when told to explicitly", async () => {
    const { manager, payer } = newManager({
      minter: undefined,
      allowSessionWithoutRefund: true,
    });
    await payer.expectLabel(300, "forfeit");

    const challenge = await offer({ depositSat: 300, label: "forfeit" });
    const record = await manager.open({
      key: "k",
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    expect(record.returnInvoice).toBe("");
  });

  it("refuses a challenge whose payment hash the preimage contradicts", async () => {
    // A challenge naming a hash the paid preimage does not produce was
    // describing a different invoice than the one that got settled, so no
    // session gets built on top of it.
    const { manager, payer, store, receiptStore } = newManager();
    const challenge = await offer({ depositSat: 300, label: "quoted" });

    // The wallet settles the quoted invoice with somebody else's preimage.
    payer.expect(invoiceFor(300, "quoted"), preimageFor("other"));

    await expect(
      manager.open({
        key: "k",
        origin: ORIGIN,
        url: URL_UNDER_TEST,
        challenge,
      }),
    ).rejects.toThrow(/but the challenge named payment hash/);

    expect(store.size).toBe(0);

    // The payment settled before the mismatch was known, so the spend is in
    // the ledger even though no session was built on it.
    const entry = receiptStore.get(await hashFor("other"));
    expect(entry?.amountSat).toBe(300);
    expect(entry?.preimageHex).toBe(preimageFor("other"));
  });

  it("records the spend before refusing a top-up hash mismatch", async () => {
    const { manager, payer, key, receiptStore } = await openOne();
    const challenge = await offer({ depositSat: 500, label: "tampered" });

    payer.expect(invoiceFor(500, "tampered"), preimageFor("other"));

    await expect(
      manager.topUp({ key, url: URL_UNDER_TEST, challenge }),
    ).rejects.toThrow(/but the challenge named payment hash/);

    const entry = receiptStore.get(await hashFor("other"));
    expect(entry?.amountSat).toBe(500);
  });

  it("refuses a session offer with no deposit invoice", async () => {
    const { manager } = newManager();
    const challenge = await offer({
      depositSat: 300,
      label: "noinvoice",
      withoutDepositInvoice: true,
    });

    await expect(
      manager.open({
        key: "k",
        origin: ORIGIN,
        url: URL_UNDER_TEST,
        challenge,
      }),
    ).rejects.toThrow(/no deposit invoice/);
  });

  it("returns the existing session instead of depositing again", async () => {
    const { manager, payer, key, challenge, record } = await openOne();
    const again = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    // The same session, not merely a session: `sessionId` is a non-optional
    // string, so asserting only that it is defined would hold for a second
    // one opened under a different id.
    expect(again.sessionId).toBe(record.sessionId);
    expect(payer.paid).toHaveLength(1);
  });

  it("asserts the deposit on the larger of the quote and the invoice", async () => {
    // The wallet pays what the invoice says, not what the quote says. Every
    // fixture has the two agreeing, which is exactly the case that cannot
    // tell a maximum from either operand on its own.
    const assertAllowed = vi.fn(async (_input: unknown) => {});
    const { manager, payer } = newManager({ buyerPolicy: { assertAllowed } });

    const challenge = await offer({ depositSat: 300, label: "understated" });

    // The seller quotes 300 and hands over an invoice for 900.
    (challenge.request as { depositInvoice?: string }).depositInvoice =
      invoiceFor(900, "understated");
    payer.expect(invoiceFor(900, "understated"), preimageFor("understated"));

    const record = await manager.open({
      key: "k",
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    expect(assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ amountSat: 900 }),
    );
    expect(record.depositedSat).toBe(900);
  });

  it("refuses a minter that hands back an empty invoice", async () => {
    // An empty string is not a refund path, and a deposit paid without one
    // leaves every unspent satoshi with the seller.
    const payer = new ScriptedPayer();
    await payer.expectLabel(300, "emptymint");

    const manager = new SessionManager({
      payer,
      store: new SessionCache(),
      minter: { mintAmountlessInvoice: async () => ({ invoice: "" }) },
    });

    await expect(
      manager.open({
        key: "k",
        origin: ORIGIN,
        url: URL_UNDER_TEST,
        challenge: await offer({ depositSat: 300, label: "emptymint" }),
      }),
    ).rejects.toThrow(/produced no invoice/);

    expect(payer.paid).toEqual([]);
  });

  it("keeps the paid session when the store refuses the write", async () => {
    // The deposit has settled by the time the store is asked. Failing the
    // call here would discard the in-memory record too, and with it the
    // session id, the deposit preimage, and the return invoice, which is
    // everything a close needs to get the deposit back. So the record comes
    // back anyway, and the lost durability is at least said out loud.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payer = new ScriptedPayer();
    await payer.expectLabel(300, "lost");

    const store = new SessionCache();
    store.put = () => {
      throw new Error("disk full");
    };

    const manager = new SessionManager({
      payer,
      store,
      minter: new MockReturnInvoiceMinter(),
    });

    const record = await manager.open({
      key: "k",
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge: await offer({ depositSat: 300, label: "lost" }),
    });

    expect(record.depositedSat).toBe(300);
    expect(record.depositPreimage).toBe(preimageFor("lost"));
    expect(payer.paid).toEqual([invoiceFor(300, "lost")]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/session store refused/),
      expect.anything(),
    );
    warn.mockRestore();
  });
});

describe("concurrent opens", () => {
  it("buys one deposit no matter how many requests race in", async () => {
    // This is the property that costs money when it is wrong. Two requests
    // that both find no session must not each pay one.
    const { manager, payer, store } = newManager();
    await payer.expectLabel(300, "race");

    const challenge = await offer({ depositSat: 300, label: "race" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);

    const records = await Promise.all(
      Array.from({ length: 8 }, () =>
        manager.open({
          key,
          origin: ORIGIN,
          url: URL_UNDER_TEST,
          challenge,
        }),
      ),
    );

    expect(payer.paid).toHaveLength(1);
    expect(store.size).toBe(1);
    expect(new Set(records.map((r) => r.sessionId)).size).toBe(1);
  });

  it("lets a later open proceed after a failed one", async () => {
    // A coalesced failure must not poison the key: the next caller has to
    // be able to try again rather than inherit a rejected promise forever.
    const { manager, payer } = newManager();
    const challenge = await offer({ depositSat: 300, label: "retry" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);

    await expect(
      manager.open({ key, origin: ORIGIN, url: URL_UNDER_TEST, challenge }),
    ).rejects.toThrow(/no preimage/);

    await payer.expectLabel(300, "retry");
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    expect(record.depositedSat).toBe(300);
    expect(payer.paid).toHaveLength(1);
  });

  it("buys one top-up no matter how many requests race in", async () => {
    const { manager, payer, key } = await openOne();
    await payer.expectLabel(500, "topup");

    const topUpOffer = await offer({ depositSat: 500, label: "topup" });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        manager.topUp({ key, url: URL_UNDER_TEST, challenge: topUpOffer }),
      ),
    );

    // One deposit and one top-up, not one top-up per racing caller.
    expect(payer.paid).toHaveLength(2);

    const record = (await manager.get(key)) as SessionRecord;
    expect(record.depositedSat).toBe(800);
  });
});

describe("topping up", () => {
  it("adds to the deposit and carries the fresh challenge forward", async () => {
    const { manager, payer, key, challenge } = await openOne();
    await payer.expectLabel(500, "topup");

    const topUpOffer = await offer({ depositSat: 500, label: "topup" });
    const record = await manager.topUp({
      key,
      url: URL_UNDER_TEST,
      challenge: topUpOffer,
    });

    expect(record.depositedSat).toBe(800);
    // Bearer requests echo the most recent thing the server signed.
    expect(record.challenge.id).toBe(topUpOffer.params.id);
    expect(record.challenge.id).not.toBe(challenge.params.id);
    expect(record.sessionId).toBe(await hashFor("deposit"));
  });

  it("keeps the session id across a top-up", async () => {
    // The top-up challenge names its own invoice's hash, which is not the
    // session id, so the session's identity must not follow it.
    const { manager, payer, key, record } = await openOne();
    await payer.expectLabel(500, "topup");

    const topped = await manager.topUp({
      key,
      url: URL_UNDER_TEST,
      challenge: await offer({ depositSat: 500, label: "topup" }),
    });

    expect(topped.sessionId).toBe(record.sessionId);
  });

  it("asserts the buyer policy on a top-up too", async () => {
    // A top-up is the second place money moves under a session, and it is
    // unbounded: nothing stops a seller from refusing every bearer request
    // and quoting another deposit each time. The policy is what bounds it.
    const seen: number[] = [];
    const payer = new ScriptedPayer();
    await payer.expectLabel(300, "policy-open");
    await payer.expectLabel(500, "policy-topup");

    const manager = new SessionManager({
      payer,
      store: new SessionCache(),
      minter: new MockReturnInvoiceMinter(),
      buyerPolicy: {
        assertAllowed: async (input: { amountSat: number }) => {
          seen.push(input.amountSat);
          if (input.amountSat > 300) throw new Error("over budget");
        },
      },
    });

    const challenge = await offer({ depositSat: 300, label: "policy-open" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });
    await acknowledgeHandshake(manager, record);

    await expect(
      manager.topUp({
        key,
        url: URL_UNDER_TEST,
        challenge: await offer({ depositSat: 500, label: "policy-topup" }),
      }),
    ).rejects.toThrow(/over budget/);

    expect(seen).toEqual([300, 500]);
    expect(payer.paid).toEqual([invoiceFor(300, "policy-open")]);

    const kept = (await manager.get(key)) as SessionRecord;
    expect(kept.depositedSat).toBe(300);
  });

  it("refuses to top up a session that is not open", async () => {
    const { manager } = newManager();
    await expect(
      manager.topUp({
        key: "missing",
        url: URL_UNDER_TEST,
        challenge: await offer({ depositSat: 500, label: "topup" }),
      }),
    ).rejects.toThrow(/not open/);
  });
});

describe("balance estimation", () => {
  it("charges each request against the estimate", async () => {
    const { manager, key } = await openOne({ depositSat: 300 });

    await manager.recordSpend(key, 2);
    await manager.recordSpend(key, 2);

    const record = (await manager.get(key)) as SessionRecord;
    expect(manager.remainingSat(record)).toBe(296);
  });

  it("takes the server's number over its own", async () => {
    // The server prices metered work and settles the difference on its own
    // schedule, so the local estimate yields whenever the two disagree.
    const { manager, key } = await openOne({ depositSat: 300 });

    await manager.recordSpend(key, 10);
    await manager.reconcile(key, { remainingSat: 42 });

    const record = (await manager.get(key)) as SessionRecord;
    expect(manager.remainingSat(record)).toBe(42);
  });

  it("applies a mid-stream exhaustion notice", async () => {
    const { manager, key } = await openOne({ depositSat: 300 });

    await manager.applyNeedTopUp(key, {
      sessionId: "ignored",
      balanceSpent: 300,
      balanceRequired: 2,
    });

    const record = (await manager.get(key)) as SessionRecord;
    expect(manager.remainingSat(record)).toBe(0);
  });

  it("never reports a negative balance", async () => {
    const { manager, key } = await openOne({ depositSat: 300 });
    await manager.recordSpend(key, 1000);

    const record = (await manager.get(key)) as SessionRecord;
    expect(manager.remainingSat(record)).toBe(0);
  });

  it("does not let a negative spend credit the balance back", async () => {
    // The unit price comes off the wire. A seller quoting a negative one
    // would otherwise refill the estimate for free, and the client would
    // keep sending bearer requests against a balance it does not have.
    const { manager, key } = await openOne({ depositSat: 300 });

    await manager.recordSpend(key, 10);
    await manager.recordSpend(key, -100);

    const record = (await manager.get(key)) as SessionRecord;
    expect(manager.remainingSat(record)).toBe(290);
  });

  it("says a top-up is due once the estimate cannot cover a unit", async () => {
    const { manager, key } = await openOne({ depositSat: 300 });

    let record = (await manager.get(key)) as SessionRecord;
    expect(manager.needsTopUp(record)).toBe(false);

    await manager.recordSpend(key, 299);
    record = (await manager.get(key)) as SessionRecord;
    expect(manager.needsTopUp(record)).toBe(true);
  });

  it("never says a top-up is due when no unit price was quoted", async () => {
    const { manager, store, key } = await openOne();
    const record = (await manager.get(key)) as SessionRecord;
    store.put(key, { ...record, pricePerUnitSat: null, spentEstimateSat: 300 });

    const unpriced = (await manager.get(key)) as SessionRecord;
    expect(manager.needsTopUp(unpriced)).toBe(false);
  });
});

describe("finding a session for a request", () => {
  it("returns the most recently used session on the origin", async () => {
    const { manager, store, key } = await openOne();
    const record = (await manager.get(key)) as SessionRecord;

    store.put("other", {
      ...record,
      key: "other",
      sessionId: "older",
      lastUsedAt: "2020-01-01T00:00:00.000Z",
    });
    store.put(key, { ...record, lastUsedAt: "2030-01-01T00:00:00.000Z" });

    const found = await manager.findForOrigin(ORIGIN);
    expect(found?.key).toBe(key);
  });

  it("ignores sessions on another origin", async () => {
    const { manager } = await openOne();
    expect(await manager.findForOrigin("https://elsewhere.example")).toBeNull();
  });

  it("ignores a closed session", async () => {
    const { manager, store, key } = await openOne();
    const record = (await manager.get(key)) as SessionRecord;
    store.put(key, { ...record, closedAt: "2026-03-10T21:00:00Z" });

    expect(await manager.findForOrigin(ORIGIN)).toBeNull();
    expect(await manager.get(key)).toBeNull();
  });
});

describe("closing a session", () => {
  it("sends a close credential and reports the refund", async () => {
    const { manager, key, record } = await openOne({ depositSat: 300 });

    const sent: Array<{ url: string; authorization: string }> = [];
    const outcome = await manager.close(key, async (input) => {
      sent.push(input);
      return receiptResponse({
        reference: record.sessionId,
        refundSats: 140,
        refundStatus: "succeeded",
      });
    });

    expect(sent[0]?.url).toBe(URL_UNDER_TEST);
    expect(sent[0]?.authorization).toMatch(/^Payment /);
    expect(outcome?.refundSats).toBe(140);
    expect(outcome?.refundStatus).toBe("succeeded");
  });

  it("carries the deposit preimage as proof of who funded it", async () => {
    const { manager, key, label } = await openOne({ label: "proof" });

    let authorization = "";
    await manager.close(key, async (input) => {
      authorization = input.authorization;
      return receiptResponse({ reference: "x", refundStatus: "skipped" });
    });

    const json = JSON.parse(
      Buffer.from(authorization.slice("Payment ".length), "base64url")
        .toString(),
    );
    expect(json.payload).toMatchObject({
      action: "close",
      preimage: preimageFor(label),
    });
  });

  it("marks the session closed only after the server agrees", async () => {
    // Forgetting a session the server still holds throws the deposit away.
    const { manager, key } = await openOne();

    await manager.close(key, async () => new Response("nope", { status: 500 }));
    expect(await manager.get(key)).not.toBeNull();

    await manager.close(key, async () =>
      receiptResponse({ reference: "x", refundStatus: "skipped" }),
    );
    expect(await manager.get(key)).toBeNull();
  });

  it("closes once when two callers close at the same time", async () => {
    const { manager, key } = await openOne();

    let sends = 0;
    const send = async () => {
      sends += 1;
      return receiptResponse({ reference: "x", refundStatus: "skipped" });
    };

    await Promise.all([
      manager.close(key, send),
      manager.close(key, send),
      manager.close(key, send),
    ]);

    expect(sends).toBe(1);
  });

  it("waits for a deposit in flight before closing", async () => {
    // A close that races a top-up would ask for a refund of a balance the
    // server has not finished crediting.
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "slow");

    const challenge = await offer({ depositSat: 300, label: "slow" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);

    const opening = manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const closing = manager.close(key, async () =>
      receiptResponse({ reference: "x", refundStatus: "skipped" }),
    );

    const [record, outcome] = await Promise.all([opening, closing]);
    expect(record.depositedSat).toBe(300);
    expect(outcome).not.toBeNull();
    expect(await manager.get(key)).toBeNull();
  });

  it("reports a receipt that references a different session", async () => {
    const mismatches: Array<{ reasons: string[] }> = [];
    const { payer } = newManager();
    await payer.expectLabel(300, "mismatch");

    const withReporter = new SessionManager({
      payer,
      store: new SessionCache(),
      minter: new MockReturnInvoiceMinter(),
      onReceiptMismatch: (mismatch) => mismatches.push(mismatch),
    });

    const challenge = await offer({ depositSat: 300, label: "mismatch" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    await withReporter.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    await withReporter.close(key, async () =>
      receiptResponse({
        reference: "some-other-session",
        refundSats: 140,
        refundStatus: "succeeded",
      }),
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.reasons.join(" ")).toMatch(/receipt references/);
  });

  it("returns null for a session that is not open", async () => {
    const { manager } = newManager();
    expect(await manager.close("missing", async () => new Response())).toBeNull();
  });

  it("keeps closing after one session fails to close", async () => {
    // A network error against one seller must not cost the refunds owed by
    // every other seller.
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "one");
    await payer.expectLabel(400, "two");

    await manager.open({
      key: "a",
      origin: ORIGIN,
      url: `${ORIGIN}/a`,
      challenge: await offer({ depositSat: 300, label: "one" }),
    });
    await manager.open({
      key: "b",
      origin: ORIGIN,
      url: `${ORIGIN}/b`,
      challenge: await offer({ depositSat: 400, label: "two" }),
    });

    const outcomes = await manager.closeAll(async ({ url }) => {
      if (url.endsWith("/a")) throw new Error("connection reset");
      return receiptResponse({ reference: "x", refundStatus: "skipped" });
    });

    expect(outcomes).toHaveLength(1);

    // The one that failed is still open, so a caller can retry or report it.
    const stillOpen = await manager.listOpen();
    expect(stillOpen.map((r) => r.key)).toEqual(["a"]);
  });

  it("closes every open session", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "one");
    await payer.expectLabel(400, "two");

    const first = await offer({ depositSat: 300, label: "one" });
    const second = await offer({ depositSat: 400, label: "two" });

    await manager.open({
      key: "a",
      origin: ORIGIN,
      url: `${ORIGIN}/a`,
      challenge: first,
    });
    await manager.open({
      key: "b",
      origin: ORIGIN,
      url: `${ORIGIN}/b`,
      challenge: second,
    });

    const outcomes = await manager.closeAll(async () =>
      receiptResponse({ reference: "x", refundStatus: "skipped" }),
    );

    expect(outcomes).toHaveLength(2);
    expect(await manager.listOpen()).toEqual([]);
  });
});

describe("the deposit handshake", () => {
  it("presents the open credential until the server has answered it", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "shake");

    const challenge = await offer({ depositSat: 300, label: "shake" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const first = await manager.credentialForRequest(record);
    expect(first.action).toBe("open");

    const payload = JSON.parse(
      Buffer.from(first.authorization.slice("Payment ".length), "base64url")
        .toString(),
    ).payload;
    expect(payload).toMatchObject({
      action: "open",
      preimage: preimageFor("shake"),
    });
    expect(payload.returnInvoice).toBeTruthy();

    // The server accepts it, and only then does the session speak bearer.
    await manager.reportPresentation(first, { ok: true, status: 200 });

    const second = await manager.credentialForRequest(record);
    expect(second.action).toBe("bearer");
    const bearer = JSON.parse(
      Buffer.from(second.authorization.slice("Payment ".length), "base64url")
        .toString(),
    ).payload;
    expect(bearer).toMatchObject({
      action: "bearer",
      sessionId: await hashFor("shake"),
      preimage: preimageFor("shake"),
    });
    await manager.reportPresentation(second, { ok: true, status: 200 });
  });

  it("keeps the open handshake owed when no response arrived", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "lostopen");

    const challenge = await offer({ depositSat: 300, label: "lostopen" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const first = await manager.credentialForRequest(record);
    await manager.reportPresentation(first, null);

    const again = await manager.credentialForRequest(record);
    expect(again.action).toBe("open");
    await manager.reportPresentation(again, { ok: true, status: 200 });
  });

  it("retires a refused open, since the server never accepts its replay", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "refusedopen");

    const challenge = await offer({ depositSat: 300, label: "refusedopen" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const first = await manager.credentialForRequest(record);
    await manager.reportPresentation(first, { ok: false, status: 402 });

    const probe = await manager.credentialForRequest(record);
    expect(probe.action).toBe("bearer");
    await manager.reportPresentation(probe, { ok: true, status: 200 });
  });

  it("keeps a refused topUp owed, since its replay credits at most once", async () => {
    const { manager, payer, key, record } = await openOne();
    await payer.expectLabel(500, "owedtopup");

    const topped = await manager.topUp({
      key,
      url: URL_UNDER_TEST,
      challenge: await offer({ depositSat: 500, label: "owedtopup" }),
    });
    expect(topped.pendingHandshake?.action).toBe("topUp");

    const first = await manager.credentialForRequest(topped);
    expect(first.action).toBe("topUp");
    await manager.reportPresentation(first, { ok: false, status: 402 });

    // Still owed: the refusal may have been about anything, and only a
    // served topUp is known to have credited the balance.
    const again = await manager.credentialForRequest(record);
    expect(again.action).toBe("topUp");
    const payload = JSON.parse(
      Buffer.from(again.authorization.slice("Payment ".length), "base64url")
        .toString(),
    ).payload;
    expect(payload).toMatchObject({
      action: "topUp",
      sessionId: record.sessionId,
      topUpPreimage: preimageFor("owedtopup"),
    });
    await manager.reportPresentation(again, { ok: true, status: 200 });
  });

  it("refuses to buy a top-up while a handshake is unacknowledged", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "guard");
    await payer.expectLabel(500, "guard-topup");

    const challenge = await offer({ depositSat: 300, label: "guard" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    await manager.open({ key, origin: ORIGIN, url: URL_UNDER_TEST, challenge });

    await expect(
      manager.topUp({
        key,
        url: URL_UNDER_TEST,
        challenge: await offer({ depositSat: 500, label: "guard-topup" }),
      }),
    ).rejects.toThrow(/unacknowledged open handshake/);

    expect(payer.paid).toEqual([invoiceFor(300, "guard")]);
  });

  it("lets one presenter carry the handshake for every concurrent caller", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "herd");

    const challenge = await offer({ depositSat: 300, label: "herd" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const first = await manager.credentialForRequest(record);
    expect(first.action).toBe("open");

    // A second caller arriving mid-presentation waits rather than sending a
    // second open the server is guaranteed to refuse.
    const waiting = manager.credentialForRequest(record);
    await manager.reportPresentation(first, { ok: true, status: 200 });

    const second = await waiting;
    expect(second.action).toBe("bearer");
    await manager.reportPresentation(second, { ok: true, status: 200 });
  });
});

describe("refreshing the challenge echo", () => {
  it("adopts a fresh challenge and its price for the same realm", async () => {
    const { manager, key, record } = await openOne();

    const fresh = await offer({
      depositSat: 500,
      pricePerUnitSat: 7,
      label: "fresh",
    });
    await manager.refreshChallenge(key, fresh);

    const updated = (await manager.get(key)) as SessionRecord;
    expect(updated.challenge.id).toBe(fresh.params.id);
    expect(updated.challenge.id).not.toBe(record.challenge.id);
    expect(updated.pricePerUnitSat).toBe(7);
  });

  it("ignores an offer for another realm", async () => {
    const { manager, key, record } = await openOne();

    const params = await sessionChallenge({
      depositSat: 500,
      pricePerUnitSat: 7,
      label: "elsewhere",
      realm: "other.example.com",
    });
    const foreign = paymentChallengesFromHeaders(
      challengeResponse([params]),
    )[0] as SessionChallenge;
    await manager.refreshChallenge(key, foreign);

    const kept = (await manager.get(key)) as SessionRecord;
    expect(kept.challenge.id).toBe(record.challenge.id);
  });

  it("ignores an offer that is already expired", async () => {
    const { manager, key, record } = await openOne();

    const stale = await offer({
      depositSat: 500,
      pricePerUnitSat: 7,
      label: "stale",
      expires: "2020-01-01T00:00:00Z",
    });
    await manager.refreshChallenge(key, stale);

    const kept = (await manager.get(key)) as SessionRecord;
    expect(kept.challenge.id).toBe(record.challenge.id);
  });

  it("never touches the challenge a pending handshake is pinned to", async () => {
    const { manager, payer } = newManager();
    await payer.expectLabel(300, "pinned");

    const challenge = await offer({ depositSat: 300, label: "pinned" });
    const key = SessionManager.key(ORIGIN, challenge.params.realm);
    const record = await manager.open({
      key,
      origin: ORIGIN,
      url: URL_UNDER_TEST,
      challenge,
    });

    const fresh = await offer({
      depositSat: 500,
      pricePerUnitSat: 7,
      label: "fresher",
    });
    await manager.refreshChallenge(key, fresh);

    const updated = (await manager.get(key)) as SessionRecord;
    expect(updated.challenge.id).toBe(fresh.params.id);
    expect(updated.pendingHandshake?.challenge.id).toBe(record.challenge.id);

    const presentation = await manager.credentialForRequest(record);
    expect(presentation.action).toBe("open");
    const echoed = JSON.parse(
      Buffer.from(
        presentation.authorization.slice("Payment ".length),
        "base64url",
      ).toString(),
    ).challenge;
    expect(echoed.id).toBe(record.challenge.id);
    await manager.reportPresentation(presentation, { ok: true, status: 200 });
  });
});

describe("closing with an expired echo", () => {
  it("draws a fresh challenge with a bare probe and echoes it", async () => {
    const { manager, store, key, record } = await openOne();

    // The session outlived the challenge it was opened against.
    store.put(key, {
      ...record,
      challenge: { ...record.challenge, expires: "2020-01-01T00:00:00Z" },
    });

    const fresh = await offer({ depositSat: 300, label: "freshclose" });
    const sent: string[] = [];

    const outcome = await manager.close(key, async ({ authorization }) => {
      sent.push(authorization);
      if (authorization === "") {
        return challengeResponse([fresh.params]);
      }
      return receiptResponse({
        reference: record.sessionId,
        refundStatus: "skipped",
      });
    });

    expect(outcome).not.toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe("");

    const echoed = JSON.parse(
      Buffer.from((sent[1] as string).slice("Payment ".length), "base64url")
        .toString(),
    );
    expect(echoed.challenge.id).toBe(fresh.params.id);
    expect(echoed.payload).toMatchObject({
      action: "close",
      sessionId: record.sessionId,
    });
    expect(await manager.get(key)).toBeNull();
  });

  it("still sends the close when the probe yields nothing usable", async () => {
    const { manager, store, key, record } = await openOne();

    store.put(key, {
      ...record,
      challenge: { ...record.challenge, expires: "2020-01-01T00:00:00Z" },
    });

    const sent: string[] = [];
    const outcome = await manager.close(key, async ({ authorization }) => {
      sent.push(authorization);
      if (authorization === "") {
        return new Response("no challenges here", { status: 503 });
      }
      return receiptResponse({
        reference: record.sessionId,
        refundStatus: "skipped",
      });
    });

    // Asking with the stale echo beats not asking at all.
    expect(outcome).not.toBeNull();
    expect(sent).toHaveLength(2);
  });

  it("does not probe when the stored echo is still live", async () => {
    const { manager, key, record } = await openOne();

    const sent: string[] = [];
    await manager.close(key, async ({ authorization }) => {
      sent.push(authorization);
      return receiptResponse({
        reference: record.sessionId,
        refundStatus: "skipped",
      });
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe("");
  });
});

describe("forgetting a session", () => {
  it("drops the record entirely", async () => {
    const { manager, store, key } = await openOne();
    await manager.forget(key);

    expect(store.size).toBe(0);
    expect(await manager.get(key)).toBeNull();
  });
});
