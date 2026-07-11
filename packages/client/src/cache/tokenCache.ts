/**
 * L402 token caching: the TokenStore contract the paying fetch consumes, and
 * the default in-memory implementation. Tokens are keyed by
 * origin+routeId+method.
 */

export interface CachedToken {
  macaroonB64: string;
  preimageHex: string;
  expiresAt: string;
}

/**
 * TokenStore is the storage contract the paying fetch uses for paid L402
 * tokens. Implementations may be synchronous (in-memory) or asynchronous
 * (file- or database-backed); the paying fetch awaits both. A cached token is
 * a live bearer credential for the bundle's unspent balance, so durable
 * implementations must protect it accordingly.
 */
export interface TokenStore {
  /**
   * Return the token cached under the key, or null when absent or expired.
   */
  get(key: string): CachedToken | null | Promise<CachedToken | null>;

  /** Cache a token under the key, replacing any previous entry. */
  put(key: string, token: CachedToken): void | Promise<void>;
}

export class TokenCache implements TokenStore {
  private cache = new Map<string, CachedToken>();

  /**
   * Compute the cache key from request properties. The first component is
   * the request URL's origin (scheme://host[:port]), not the bare hostname:
   * two proxies on different ports of the same host mint unrelated tokens,
   * and a plaintext origin must never share a credential with a TLS one.
   */
  static cacheKey(origin: string, routeId: string, method: string): string {
    return `${origin}|${routeId}|${method}`;
  }

  get(key: string): CachedToken | null {
    const token = this.cache.get(key);
    if (!token) return null;

    // Check expiry.
    if (token.expiresAt) {
      const expiresMs = new Date(token.expiresAt).getTime();
      if (Date.now() > expiresMs) {
        this.cache.delete(key);
        return null;
      }
    }

    return token;
  }

  put(key: string, token: CachedToken): void {
    this.cache.set(key, token);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
