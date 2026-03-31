/**
 * In-memory L402 token cache. Caches tokens by host+routeId+method.
 */

export interface CachedToken {
  macaroonB64: string;
  preimageHex: string;
  expiresAt: string;
}

export class TokenCache {
  private cache = new Map<string, CachedToken>();

  /** Compute cache key from request properties. */
  static cacheKey(host: string, routeId: string, method: string): string {
    return `${host}|${routeId}|${method}`;
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
