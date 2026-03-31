import { describe, it, expect } from "vitest";
import {
  encodeCaveat,
  decodeCaveat,
  buildRouteCaveats,
  servicesCaveat,
  timeoutCaveat,
  hostCaveat,
  methodCaveat,
} from "./caveats.js";

describe("caveat encoding", () => {
  it("encodeCaveat produces condition=value", () => {
    expect(encodeCaveat({ condition: "host", value: "example.com" })).toBe(
      "host=example.com",
    );
  });

  it("decodeCaveat parses condition=value", () => {
    const result = decodeCaveat("host=example.com");
    expect(result).toEqual({ condition: "host", value: "example.com" });
  });

  it("decodeCaveat handles value with equals sign", () => {
    const result = decodeCaveat("data=a=b=c");
    expect(result).toEqual({ condition: "data", value: "a=b=c" });
  });

  it("decodeCaveat returns null for invalid format", () => {
    expect(decodeCaveat("no_equals_here")).toBeNull();
  });
});

describe("caveat builders", () => {
  it("servicesCaveat formats service:tier", () => {
    expect(servicesCaveat("my_api", 0)).toEqual({
      condition: "services",
      value: "my_api:0",
    });
  });

  it("timeoutCaveat uses service_valid_until", () => {
    const c = timeoutCaveat("my_api", 1711929600);
    expect(c.condition).toBe("my_api_valid_until");
    expect(c.value).toBe("1711929600");
  });

  it("hostCaveat", () => {
    expect(hostCaveat("example.com")).toEqual({
      condition: "host",
      value: "example.com",
    });
  });

  it("methodCaveat joins with pipe", () => {
    expect(methodCaveat(["GET", "POST"])).toEqual({
      condition: "method",
      value: "GET|POST",
    });
  });
});

describe("buildRouteCaveats", () => {
  it("builds standard caveat set", () => {
    const caveats = buildRouteCaveats({
      sellerId: "seller_1",
      routeId: "search",
      paymentHash: "abc123",
      ttlSeconds: 900,
      nowUnix: 1000000,
      host: "api.example.com",
      pathPrefix: "/v1/search",
      methods: ["POST"],
    });

    // Should have: services, seller_id, route_id, payment_hash, timeout,
    // host, path_prefix, method.
    expect(caveats.length).toBe(8);

    const conditions = caveats.map((c) => c.condition);
    expect(conditions).toContain("services");
    expect(conditions).toContain("seller_id");
    expect(conditions).toContain("route_id");
    expect(conditions).toContain("payment_hash");
    expect(conditions).toContain("search_valid_until");
    expect(conditions).toContain("host");
    expect(conditions).toContain("path_prefix");
    expect(conditions).toContain("method");
  });

  it("omits optional caveats when not provided", () => {
    const caveats = buildRouteCaveats({
      sellerId: "seller_1",
      routeId: "search",
      paymentHash: "abc123",
      ttlSeconds: 900,
      nowUnix: 1000000,
    });

    // Only: services, seller_id, route_id, payment_hash, timeout.
    expect(caveats.length).toBe(5);
  });
});
