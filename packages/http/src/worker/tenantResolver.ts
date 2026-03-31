/**
 * Tenant resolution: map an incoming request to a SellerRuntimeConfig.
 */

import type { TenantResolver, SellerRuntimeConfig } from "@aperture/core";

/**
 * StaticTenantResolver: returns a fixed seller config. Useful for single-tenant
 * Workers where the seller config is embedded in the Worker code.
 */
export class StaticTenantResolver implements TenantResolver {
  constructor(private readonly config: SellerRuntimeConfig) {}

  async resolve(): Promise<SellerRuntimeConfig> {
    return this.config;
  }
}

/**
 * HostnameTenantResolver: looks up seller config by hostname from a map.
 */
export class HostnameTenantResolver implements TenantResolver {
  private readonly configs: Map<string, SellerRuntimeConfig>;

  constructor(configs: Map<string, SellerRuntimeConfig>) {
    this.configs = configs;
  }

  async resolve(request: Request): Promise<SellerRuntimeConfig> {
    const url = new URL(request.url);
    const config = this.configs.get(url.hostname);
    if (!config) {
      throw new Error(`No seller config for hostname: ${url.hostname}`);
    }
    return config;
  }
}
