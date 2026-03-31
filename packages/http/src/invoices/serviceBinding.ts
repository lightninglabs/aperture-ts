/**
 * ServiceBindingInvoiceProvider: calls an internal Worker via service binding.
 */

import type {
  InvoiceProvider,
  CreateInvoiceRequest,
  CreateInvoiceResponse,
} from "@aperture/core";

export class ServiceBindingInvoiceProvider implements InvoiceProvider {
  constructor(private readonly fetcher: Fetcher) {}

  async createInvoice(
    req: CreateInvoiceRequest,
  ): Promise<CreateInvoiceResponse> {
    const response = await this.fetcher.fetch(
      "https://internal/invoice/create",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Invoice service binding returned ${response.status}`,
      );
    }

    return response.json() as Promise<CreateInvoiceResponse>;
  }
}
