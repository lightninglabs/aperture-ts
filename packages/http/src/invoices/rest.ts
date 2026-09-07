/**
 * RestInvoiceProvider: calls an external REST endpoint for invoice creation.
 */

import type {
  InvoiceProvider,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
} from "@lightninglabs/aperture-core";

export interface RestInvoiceProviderConfig {
  endpoint: string;
  authHeader?: string;
  timeoutMs?: number;
}

export class RestInvoiceProvider implements InvoiceProvider {
  private config: RestInvoiceProviderConfig;

  constructor(config: RestInvoiceProviderConfig) {
    this.config = config;
  }

  async createInvoice(
    req: CreateInvoiceRequest,
  ): Promise<CreateInvoiceResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.authHeader) {
      headers["Authorization"] = this.config.authHeader;
    }

    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        seller_id: req.sellerId,
        route_id: req.routeId,
        amount_sat: req.amountSat,
        memo: req.memo,
        expiry_seconds: req.expirySeconds,
        metadata: req.metadata,
        idempotency_key: req.idempotencyKey,
      }),
      signal: this.config.timeoutMs
        ? AbortSignal.timeout(this.config.timeoutMs)
        : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `Invoice backend returned ${response.status}: ${await response.text()}`,
      );
    }

    const result = (await response.json()) as {
      invoice: string;
      payment_hash: string;
      expires_at: string;
      amount_sat: number;
      backend_invoice_id?: string;
    };

    return {
      invoice: result.invoice,
      paymentHash: result.payment_hash,
      expiresAt: result.expires_at,
      amountSat: result.amount_sat,
      backendInvoiceId: result.backend_invoice_id,
    };
  }
}
