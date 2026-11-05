import { describe, it, expect } from "vitest";
import { StaticTenantResolver, HostnameTenantResolver } from "./tenantResolver.js";
import type { SellerRuntimeConfig } from "@lightninglabs/aperture-core";

const mockConfig: SellerRuntimeConfig = {
  sellerId: "seller_1",
  hostnames: ["api.example.com"],
  routes: [],
  defaultCurrency: "SAT",
  auth: { scheme: "L402" },
  invoiceBackend: { kind: "mock" },
  origin: { kind: "local" },
  receipts: { mode: "async" },
};

describe("StaticTenantResolver", () => {
  it("always returns the same config", async () => {
    const resolver = new StaticTenantResolver(mockConfig);
    const req = new Request("https://api.example.com/test");
    const config = await resolver.resolve(req, {});
    expect(config.sellerId).toBe("seller_1");
  });
});

describe("HostnameTenantResolver", () => {
  it("resolves by hostname", async () => {
    const map = new Map<string, SellerRuntimeConfig>();
    map.set("api.example.com", mockConfig);

    const resolver = new HostnameTenantResolver(map);
    const req = new Request("https://api.example.com/v1/search");
    const config = await resolver.resolve(req, {});
    expect(config.sellerId).toBe("seller_1");
  });

  it("throws for unknown hostname", async () => {
    const resolver = new HostnameTenantResolver(new Map());
    const req = new Request("https://unknown.com/test");
    await expect(resolver.resolve(req, {})).rejects.toThrow("No seller config");
  });
});
