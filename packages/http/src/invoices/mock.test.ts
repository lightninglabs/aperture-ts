import { describe, it, expect } from "vitest";
import { MockInvoiceProvider } from "./mock.js";

describe("MockInvoiceProvider", () => {
  it("creates an invoice with valid fields", async () => {
    const provider = new MockInvoiceProvider();
    const result = await provider.createInvoice({
      sellerId: "seller_1",
      routeId: "search",
      amountSat: 10,
      memo: "test",
      expirySeconds: 900,
    });

    expect(result.invoice).toContain("lnbcrt");
    expect(result.paymentHash).toHaveLength(64);
    expect(result.amountSat).toBe(10);
    expect(result.expiresAt).toBeTruthy();
  });

  it("stores preimage for test verification", async () => {
    const provider = new MockInvoiceProvider();
    const result = await provider.createInvoice({
      sellerId: "seller_1",
      routeId: "search",
      amountSat: 10,
      memo: "test",
      expirySeconds: 900,
    });

    const preimage = provider.getPreimage(result.paymentHash);
    expect(preimage).toBeDefined();
    expect(preimage).toHaveLength(64);
  });

  it("preimage hashes to payment hash", async () => {
    const provider = new MockInvoiceProvider();
    const result = await provider.createInvoice({
      sellerId: "seller_1",
      routeId: "search",
      amountSat: 10,
      memo: "test",
      expirySeconds: 900,
    });

    const preimageHex = provider.getPreimage(result.paymentHash)!;
    const preimageBytes = new Uint8Array(
      preimageHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    const hashBuffer = await crypto.subtle.digest("SHA-256", preimageBytes);
    const computedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(computedHash).toBe(result.paymentHash);
  });
});
