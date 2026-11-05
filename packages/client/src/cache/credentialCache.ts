/**
 * Storage for paid `Payment` credentials.
 *
 * A charge credential is the receipt for a payment that has already
 * settled. Keeping it matters for one specific failure: the paid retry
 * throws before a response comes back, the caller retries the whole
 * request, and without a cached credential the client fetches a fresh
 * challenge and pays for the same thing twice. Presenting a spent
 * credential costs at worst one refused request and a new challenge, which
 * is where the caller would have been anyway.
 */

/** A credential that has been paid for and not yet expired. */
export interface CachedCredential {
  /** The complete `Authorization` header value, scheme included. */
  authorization: string;

  /** The challenge this credential answers, for receipt checking. */
  challengeId: string;

  /** RFC 3339 expiry from the challenge, when it carried one. */
  expiresAt?: string;
}

/**
 * The storage contract the paying fetch uses for paid credentials.
 * Implementations may be synchronous or asynchronous; every call awaits.
 */
export interface CredentialStore {
  get(
    key: string,
  ): CachedCredential | null | Promise<CachedCredential | null>;
  put(key: string, credential: CachedCredential): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Process-local credential cache that evicts expired entries on read. */
export class CredentialCache implements CredentialStore {
  private credentials = new Map<string, CachedCredential>();

  /**
   * Compute the cache key. The origin comes first for the same reason it
   * does in the token cache: two proxies on different ports mint unrelated
   * credentials, and a plaintext origin must never share one with a TLS
   * origin.
   */
  static cacheKey(origin: string, routeId: string, method: string): string {
    return `${origin}|${routeId}|${method}`;
  }

  get(key: string): CachedCredential | null {
    const credential = this.credentials.get(key);
    if (credential === undefined) return null;

    // An unparseable expiry counts as expired. NaN loses every comparison,
    // which would otherwise make a paid credential immortal, and immortal
    // is the wrong failure mode for garbage on a bearer value.
    if (credential.expiresAt) {
      const expiresMs = Date.parse(credential.expiresAt);
      if (Number.isNaN(expiresMs) || Date.now() > expiresMs) {
        this.credentials.delete(key);
        return null;
      }
    }

    return credential;
  }

  put(key: string, credential: CachedCredential): void {
    this.credentials.set(key, credential);
  }

  delete(key: string): void {
    this.credentials.delete(key);
  }

  clear(): void {
    this.credentials.clear();
  }

  get size(): number {
    return this.credentials.size;
  }
}
