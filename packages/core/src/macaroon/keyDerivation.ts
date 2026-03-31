/**
 * HKDF-based key derivation for per-seller macaroon signing keys.
 *
 * sellerMacaroonKey = HKDF(MACAROON_MASTER_KEY, "seller:${sellerId}:v1")
 *
 * Uses the Web Crypto API (available in CF Workers and Node 20+).
 */

const KEY_VERSION = "v1";
const DERIVED_KEY_BYTES = 32;

/**
 * Derive a per-seller macaroon root key from the master key.
 *
 * @param masterKeyHex The hex-encoded master macaroon key.
 * @param sellerId The seller identifier.
 * @returns Hex-encoded derived key.
 */
export async function deriveSellerKey(
  masterKeyHex: string,
  sellerId: string,
): Promise<string> {
  const masterKeyBytes = hexToBytes(masterKeyHex);
  const info = new TextEncoder().encode(`seller:${sellerId}:${KEY_VERSION}`);

  // Import master key as HKDF input keying material.
  const ikm = await crypto.subtle.importKey(
    "raw",
    masterKeyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );

  // Derive bits using HKDF with SHA-256.
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // Zero salt.
      info,
    },
    ikm,
    DERIVED_KEY_BYTES * 8,
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
