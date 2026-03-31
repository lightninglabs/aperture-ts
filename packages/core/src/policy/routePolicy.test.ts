import { describe, it, expect } from "vitest";
import { matchRoute } from "./routePolicy.js";
import type { RouteDefinition } from "../types.js";

const makeRoute = (overrides: Partial<RouteDefinition> = {}): RouteDefinition => ({
  routeId: "test_route",
  match: {},
  challengeMode: "http-402",
  pricing: { kind: "fixed", amountSat: 10 },
  macaroonPolicy: {
    ttlSeconds: 900,
    bindHost: true,
    bindPathPrefix: true,
    bindMethod: true,
    bindRouteId: true,
  },
  backend: { kind: "proxy", target: "/api" },
  ...overrides,
});

describe("matchRoute", () => {
  it("matches when no constraints are set", () => {
    const routes = [makeRoute()];
    const req = new Request("https://api.example.com/v1/search");
    expect(matchRoute(req, routes)).toBe(routes[0]);
  });

  it("matches by path prefix", () => {
    const routes = [
      makeRoute({ routeId: "search", match: { pathPrefix: "/v1/search" } }),
      makeRoute({ routeId: "fallback" }),
    ];
    const req = new Request("https://api.example.com/v1/search?q=hello");
    expect(matchRoute(req, routes)?.routeId).toBe("search");
  });

  it("rejects non-matching path prefix", () => {
    const routes = [
      makeRoute({ routeId: "search", match: { pathPrefix: "/v1/search" } }),
    ];
    const req = new Request("https://api.example.com/v1/users");
    expect(matchRoute(req, routes)).toBeNull();
  });

  it("matches by method", () => {
    const routes = [
      makeRoute({ routeId: "post_only", match: { method: ["POST"] } }),
    ];
    const getReq = new Request("https://api.example.com/");
    expect(matchRoute(getReq, routes)).toBeNull();

    const postReq = new Request("https://api.example.com/", { method: "POST" });
    expect(matchRoute(postReq, routes)?.routeId).toBe("post_only");
  });

  it("matches by host", () => {
    const routes = [
      makeRoute({ routeId: "specific", match: { host: "api.example.com" } }),
    ];
    const req = new Request("https://api.example.com/test");
    expect(matchRoute(req, routes)?.routeId).toBe("specific");

    const wrongHost = new Request("https://other.example.com/test");
    expect(matchRoute(wrongHost, routes)).toBeNull();
  });

  it("matches wildcard host", () => {
    const routes = [
      makeRoute({ routeId: "wildcard", match: { host: "*.example.com" } }),
    ];
    const req = new Request("https://api.example.com/test");
    expect(matchRoute(req, routes)?.routeId).toBe("wildcard");

    const sub = new Request("https://sub.example.com/test");
    expect(matchRoute(sub, routes)?.routeId).toBe("wildcard");
  });

  it("returns first matching route", () => {
    const routes = [
      makeRoute({ routeId: "first", match: { pathPrefix: "/v1" } }),
      makeRoute({ routeId: "second", match: { pathPrefix: "/v1" } }),
    ];
    const req = new Request("https://api.example.com/v1/test");
    expect(matchRoute(req, routes)?.routeId).toBe("first");
  });
});
