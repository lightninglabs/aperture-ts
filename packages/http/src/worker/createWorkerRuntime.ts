/**
 * createApertureWorkerRuntime: factory for the CF Worker fetch handler.
 * Design doc section 8.2.
 */

import type { WorkerRuntimeConfig } from "@aperture/core";
import type { Env } from "../cloudflare/bindings.js";
import { handleRequest, type RequestHandlerDeps } from "./sellerContext.js";
import { ApertureError, errorToResponse } from "./errors.js";

export interface ApertureWorkerRuntime {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response>;
}

export function createApertureWorkerRuntime(
  config: WorkerRuntimeConfig,
): ApertureWorkerRuntime {
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        // Resolve tenant.
        const seller = await config.tenantResolver.resolve(request, env);

        // Build per-request deps.
        const invoiceProvider = config.invoiceProviderFactory.create(
          seller.invoiceBackend,
        );
        const originAdapter = config.originAdapterFactory.create(
          seller.origin,
        );

        const deps: RequestHandlerDeps = {
          invoiceProvider,
          originAdapter,
          macaroonIssuer: config.macaroonIssuer,
          macaroonVerifier: config.macaroonVerifier,
          receiptWriter: config.receiptWriter,
          stateStore: config.stateStore,
        };

        return await handleRequest(
          request,
          seller,
          deps,
          (p) => ctx.waitUntil(p),
        );
      } catch (err) {
        if (err instanceof ApertureError) {
          return errorToResponse(err);
        }

        const message = err instanceof Error ? err.message : String(err);
        return errorToResponse(
          new ApertureError("internal_error", message),
        );
      }
    },
  };
}
