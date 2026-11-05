/**
 * A stand-in for the wallet capability that mints the session's refund
 * invoice, for development and tests.
 *
 * The invoices it produces are not real BOLT11, so a server that decodes
 * them will reject them. That is deliberate: the point of this class is to
 * exercise the flow that requires a return invoice, not to pretend that one
 * exists.
 */

import type { ReturnInvoiceMinter } from "./sessionManager.js";

export class MockReturnInvoiceMinter implements ReturnInvoiceMinter {
  private counter = 0;

  /** Every invoice this minter has handed out, in order. */
  readonly minted: string[] = [];

  constructor(private readonly prefix = "lnbcrt1mock") {}

  async mintAmountlessInvoice(input: {
    origin: string;
    realm: string;
    memo?: string;
  }): Promise<{ invoice: string }> {
    this.counter += 1;
    const invoice = `${this.prefix}${this.counter}${slug(input.realm)}`;
    this.minted.push(invoice);

    return { invoice };
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
