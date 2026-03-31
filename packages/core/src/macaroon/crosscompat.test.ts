/**
 * Cross-compatibility tests: verify the WASM bridge produces identical output
 * to the Go test vectors.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, type ApertureWasm } from "./wasm.js";

interface TestVector {
  name: string;
  rootKeyHex: string;
  preimageHex: string;
  paymentHash: string;
  tokenIdHex: string;
  caveats: Array<{ condition: string; value: string }> | null;
  identifierHex?: string;
}

let wasm: ApertureWasm;
let vectors: TestVector[];

beforeAll(async () => {
  wasm = await initWasm();

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const vectorPath = join(thisDir, "..", "..", "..", "wasm", "testdata", "vectors.json");
  const raw = await readFile(vectorPath, "utf-8");
  vectors = JSON.parse(raw) as TestVector[];
});

describe("cross-compatibility with Go test vectors", () => {
  it("preimage → paymentHash matches Go output", () => {
    const v = vectors.find((v) => v.name === "preimage_to_hash")!;
    const result = wasm.verifyPreimage(v.preimageHex, v.paymentHash);
    expect(result).toBe(true);
  });

  it("identifier roundtrip matches Go encoding", () => {
    const v = vectors.find((v) => v.name === "identifier_roundtrip")!;

    // Encode.
    const encoded = wasm.encodeIdentifier(v.paymentHash, v.tokenIdHex);
    expect(encoded).toBe(v.identifierHex);

    // Decode.
    const decoded = wasm.decodeIdentifier(v.identifierHex!);
    expect(decoded.version).toBe(0);
    expect(decoded.paymentHashHex).toBe(v.paymentHash);
    expect(decoded.tokenIdHex).toBe(v.tokenIdHex);
  });

  it("service caveat format matches Go encoding", () => {
    const v = vectors.find((v) => v.name === "service_caveat")!;
    expect(v.caveats).toBeDefined();
    expect(v.caveats![0]!.condition).toBe("services");
    expect(v.caveats![0]!.value).toBe("test_api:0");
  });
});
