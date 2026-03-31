import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { initWasm, type ApertureWasm } from "./wasm.js";

let wasm: ApertureWasm;

beforeAll(async () => {
  wasm = await initWasm();
});

describe("WASM bridge smoke tests", () => {
  it("verifyPreimage: sha256(preimage) === paymentHash", () => {
    // Known test vector: preimage → sha256 → paymentHash.
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256").update(preimage).digest();

    const result = wasm.verifyPreimage(
      preimage.toString("hex"),
      paymentHash.toString("hex"),
    );
    expect(result).toBe(true);
  });

  it("verifyPreimage: wrong preimage returns false", () => {
    const preimage = randomBytes(32);
    const wrongHash = randomBytes(32);

    const result = wasm.verifyPreimage(
      preimage.toString("hex"),
      wrongHash.toString("hex"),
    );
    expect(result).toBe(false);
  });

  it("encodeIdentifier + decodeIdentifier roundtrip", () => {
    const paymentHash = randomBytes(32).toString("hex");
    const tokenId = randomBytes(32).toString("hex");

    const encoded = wasm.encodeIdentifier(paymentHash, tokenId);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = wasm.decodeIdentifier(encoded);
    expect(decoded.version).toBe(0);
    expect(decoded.paymentHashHex).toBe(paymentHash);
    expect(decoded.tokenIdHex).toBe(tokenId);
  });

  it("mintMacaroon + verifyMacaroon roundtrip", () => {
    const rootKey = randomBytes(32).toString("hex");
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256")
      .update(preimage)
      .digest("hex");

    const caveats = [
      { condition: "services", value: "test_service:0" },
      { condition: "test_service_valid_until", value: "9999999999" },
    ];

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, caveats);
    expect(mintResult.macaroonB64).toBeDefined();
    expect(mintResult.tokenIdHex).toHaveLength(64);
    expect(mintResult.identifierHex).toHaveLength(132); // 2+64+64 hex chars = 66 bytes

    // Verify the macaroon signature is valid.
    const verifyResult = wasm.verifyMacaroon(
      rootKey,
      mintResult.macaroonB64,
    );
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.caveats).toHaveLength(2);
    expect(verifyResult.caveats![0]!.condition).toBe("services");
    expect(verifyResult.caveats![0]!.value).toBe("test_service:0");
  });

  it("verifyMacaroon rejects wrong root key", () => {
    const rootKey = randomBytes(32).toString("hex");
    const wrongKey = randomBytes(32).toString("hex");
    const paymentHash = randomBytes(32).toString("hex");

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, []);

    const verifyResult = wasm.verifyMacaroon(
      wrongKey,
      mintResult.macaroonB64,
    );
    expect(verifyResult.valid).toBe(false);
    expect(verifyResult.error).toBeDefined();
  });

  it("verifyCaveats: valid service + non-expired token passes", () => {
    const rootKey = randomBytes(32).toString("hex");
    const paymentHash = randomBytes(32).toString("hex");
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;

    const caveats = [
      { condition: "services", value: "my_api:0" },
      {
        condition: "my_api_valid_until",
        value: futureTimestamp.toString(),
      },
    ];

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, caveats);

    const nowUnix = Math.floor(Date.now() / 1000);
    const result = wasm.verifyCaveats(
      mintResult.macaroonB64,
      rootKey,
      "my_api",
      nowUnix,
    );

    expect(result.valid).toBe(true);
  });

  it("verifyCaveats: expired token fails", () => {
    const rootKey = randomBytes(32).toString("hex");
    const paymentHash = randomBytes(32).toString("hex");
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;

    const caveats = [
      { condition: "services", value: "my_api:0" },
      {
        condition: "my_api_valid_until",
        value: pastTimestamp.toString(),
      },
    ];

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, caveats);

    const nowUnix = Math.floor(Date.now() / 1000);
    const result = wasm.verifyCaveats(
      mintResult.macaroonB64,
      rootKey,
      "my_api",
      nowUnix,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("verifyCaveats: wrong service name fails", () => {
    const rootKey = randomBytes(32).toString("hex");
    const paymentHash = randomBytes(32).toString("hex");
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;

    const caveats = [
      { condition: "services", value: "allowed_service:0" },
      {
        condition: "allowed_service_valid_until",
        value: futureTimestamp.toString(),
      },
    ];

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, caveats);

    const result = wasm.verifyCaveats(
      mintResult.macaroonB64,
      rootKey,
      "wrong_service",
      Math.floor(Date.now() / 1000),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not authorized");
  });

  it("addFirstPartyCaveats: adds caveat and verification still passes", () => {
    const rootKey = randomBytes(32).toString("hex");
    const paymentHash = randomBytes(32).toString("hex");

    const mintResult = wasm.mintMacaroon(rootKey, paymentHash, [
      { condition: "services", value: "svc:0" },
    ]);

    // Add a timeout caveat via addFirstPartyCaveats.
    const futureTs = (Math.floor(Date.now() / 1000) + 3600).toString();
    const updated = wasm.addFirstPartyCaveats(mintResult.macaroonB64, [
      { condition: "svc_valid_until", value: futureTs },
    ]);

    expect(typeof updated).toBe("string");

    // Verify the updated macaroon still has a valid signature.
    const verifyResult = wasm.verifyMacaroon(rootKey, updated);
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.caveats).toHaveLength(2);
  });
});
