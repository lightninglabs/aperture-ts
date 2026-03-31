/**
 * Native CF Worker adapter: wraps createApertureWorkerRuntime into a
 * standard CF Worker export default { fetch() } pattern.
 */

import type { ApertureWorkerRuntime } from "../worker/createWorkerRuntime.js";
import type { Env } from "../cloudflare/bindings.js";

/**
 * Create a standard Cloudflare Worker module export from an Aperture runtime.
 */
export function createWorkerExport(
  runtime: ApertureWorkerRuntime,
): ExportedHandler<Env> {
  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return runtime.fetch(request, env, ctx);
    },
  };
}
