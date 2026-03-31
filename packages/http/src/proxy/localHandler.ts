/**
 * LocalWorkerHandlerAdapter: invokes a seller-supplied handler inside
 * the same Worker bundle. Design doc section 18.2.
 */

import type {
  OriginAdapter,
  OriginExecutionInput,
  VerifiedL402Context,
} from "@aperture/core";

/** Handler function that the seller provides in their Worker code. */
export type LocalHandler = (
  request: Request,
  context: { auth: VerifiedL402Context | null },
) => Promise<Response> | Response;

export class LocalWorkerHandlerAdapter implements OriginAdapter {
  constructor(private readonly handler: LocalHandler) {}

  async execute(input: OriginExecutionInput): Promise<Response> {
    return this.handler(input.request, {
      auth: input.auth ?? null,
    });
  }
}
