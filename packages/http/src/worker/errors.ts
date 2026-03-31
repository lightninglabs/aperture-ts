/**
 * Error model and HTTP status mapping per design doc section 20.
 */

import type { ApertureErrorCode } from "@aperture/core";

const STATUS_MAP: Record<ApertureErrorCode, number> = {
  route_not_found: 404,
  payment_required: 402,
  invalid_authorization_header: 400,
  macaroon_invalid: 402,
  preimage_invalid: 402,
  credential_expired: 402,
  insufficient_scope: 402,
  invoice_backend_unavailable: 503,
  origin_unavailable: 502,
  policy_denied: 403,
  internal_error: 500,
};

export class ApertureError extends Error {
  constructor(
    public readonly code: ApertureErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApertureError";
  }
}

export function errorToResponse(error: ApertureError): Response {
  const status = STATUS_MAP[error.code] ?? 500;
  return new Response(
    JSON.stringify({ error: error.code, message: error.message }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}
