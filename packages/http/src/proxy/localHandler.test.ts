import { describe, it, expect } from "vitest";
import { LocalWorkerHandlerAdapter } from "./localHandler.js";
import type { SellerRuntimeConfig, RouteDefinition } from "@lightninglabs/aperture-core";

describe("LocalWorkerHandlerAdapter", () => {
  it("invokes the handler and returns its response", async () => {
    const handler = async (req: Request) => {
      return new Response(`Hello from ${new URL(req.url).pathname}`, {
        status: 200,
      });
    };

    const adapter = new LocalWorkerHandlerAdapter(handler);
    const request = new Request("https://api.example.com/v1/test");
    const response = await adapter.execute({
      request,
      seller: {} as SellerRuntimeConfig,
      route: {} as RouteDefinition,
      auth: null,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello from /v1/test");
  });

  it("passes auth context to handler", async () => {
    const handler = async (_req: Request, ctx: { auth: unknown }) => {
      return Response.json({ hasAuth: ctx.auth !== null });
    };

    const adapter = new LocalWorkerHandlerAdapter(handler);
    const response = await adapter.execute({
      request: new Request("https://api.example.com/"),
      seller: {} as SellerRuntimeConfig,
      route: {} as RouteDefinition,
      auth: {
        sellerId: "s1",
        routeId: "r1",
        paymentHash: "abc",
        expiresAt: "",
        rawMacaroonB64: "",
        rawPreimageHex: "",
      },
    });

    const body = await response.json() as { hasAuth: boolean };
    expect(body.hasAuth).toBe(true);
  });
});
