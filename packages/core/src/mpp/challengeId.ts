/**
 * The HMAC binding that ties a challenge id to the challenge parameters.
 *
 * A server issues challenges statelessly: rather than remembering what it
 * offered, it signs the offer and recognizes its own signature when the
 * credential comes back. The input is seven fixed positional slots joined
 * with "|", so that a parameter moving between present and absent changes
 * the input rather than colliding with some other combination.
 *
 * A buyer holds no server secret and so cannot verify a challenge id. These
 * functions live in the shared core because both sides of this codebase use
 * them: a TypeScript seller to issue and verify, and the buyer's tests to
 * build challenges a Go seller would accept.
 */

import { encodeBase64Url } from "./base64url.js";
import type { ChallengeParams } from "./types.js";

/**
 * Build the pipe-delimited HMAC input for a challenge.
 *
 * The slots are, in order: realm, method, intent, request, expires, digest,
 * opaque. The first four are required and the last three contribute an
 * empty slot when absent. Two of the slots hold base64url text rather than
 * raw JSON, which is what keeps "|" out of the values themselves.
 */
export function buildChallengeHmacInput(
  params: Omit<ChallengeParams, "id"> & { id?: string },
): string {
  return [
    params.realm,
    params.method,
    params.intent,
    params.request,
    params.expires ?? "",
    params.digest ?? "",
    params.opaque ?? "",
  ].join("|");
}

/**
 * Compute the challenge id binding these parameters under the given secret.
 *
 * Note that `description` is deliberately outside the binding: it is the one
 * challenge parameter a server may render differently per request without
 * invalidating the offer.
 */
export async function computeChallengeId(
  secret: Uint8Array | string,
  params: Omit<ChallengeParams, "id"> & { id?: string },
): Promise<string> {
  const raw =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;

  // Web Crypto rejects a zero-length HMAC key, while the reference
  // implementation accepts one. HMAC pads any key shorter than the block
  // size with zeros, so a single zero byte produces the same tag an empty
  // key would, and an empty secret keeps working rather than throwing.
  const keyBytes = copyBytes(raw.length === 0 ? new Uint8Array(1) : raw);

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const input = copyBytes(
    new TextEncoder().encode(buildChallengeHmacInput(params)),
  );
  const signature = await crypto.subtle.sign("HMAC", key, input);

  return encodeBase64Url(new Uint8Array(signature));
}

/**
 * Verify that a challenge id is the binding for these parameters. The
 * comparison runs over the full length of both strings so that a mismatch
 * costs the same time wherever it falls.
 */
export async function verifyChallengeId(
  secret: Uint8Array | string,
  params: Omit<ChallengeParams, "id"> & { id?: string },
  id: string,
): Promise<boolean> {
  const expected = await computeChallengeId(secret, params);
  return constantTimeEquals(expected, id);
}

/**
 * Copy bytes into a view backed by a plain ArrayBuffer. Web Crypto's
 * BufferSource excludes views over a SharedArrayBuffer, which is what the
 * generic Uint8Array type admits.
 */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  let diff = left.length ^ right.length;
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    diff |= (left[i] as number) ^ (right[i] as number);
  }

  return diff === 0;
}
