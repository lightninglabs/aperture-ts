/**
 * WASM loader and TypeScript wrapper for the Go-compiled L402 macaroon
 * bridge. Loads aperture.wasm and exposes typed functions for minting,
 * verifying, and manipulating macaroons.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------------------
// Types exposed to consumers.
// --------------------------------------------------------------------------

/** A macaroon caveat: condition=value pair. */
export interface Caveat {
  condition: string;
  value: string;
}

/** Decoded L402 identifier components. */
export interface MacaroonIdentifier {
  version: number;
  paymentHashHex: string;
  tokenIdHex: string;
}

/** Result from mintMacaroon. */
export interface MintResult {
  macaroonB64: string;
  tokenIdHex: string;
  identifierHex: string;
}

/** Result from verifyMacaroon / verifyCaveats. */
export interface VerifyResult {
  valid: boolean;
  caveats?: Caveat[];
  error?: string;
}

/** The full WASM bridge interface exposed to TypeScript. */
export interface ApertureWasm {
  mintMacaroon(
    rootKeyHex: string,
    paymentHashHex: string,
    caveats: Caveat[],
  ): MintResult;

  verifyMacaroon(rootKeyHex: string, macaroonB64: string): VerifyResult;

  verifyPreimage(preimageHex: string, paymentHashHex: string): boolean;

  encodeIdentifier(paymentHashHex: string, tokenIdHex: string): string;

  decodeIdentifier(identifierHex: string): MacaroonIdentifier;

  verifyCaveats(
    macaroonB64: string,
    rootKeyHex: string,
    targetService: string,
    nowUnix: number,
  ): VerifyResult;

  addFirstPartyCaveats(macaroonB64: string, caveats: Caveat[]): string;
}

// --------------------------------------------------------------------------
// WASM loading and initialization.
// --------------------------------------------------------------------------

let wasmInstance: ApertureWasm | null = null;
let initPromise: Promise<ApertureWasm> | null = null;

/**
 * Initialize the WASM runtime. Safe to call multiple times; the module is
 * loaded only once. Returns the typed bridge interface.
 *
 * @param wasmPath Optional override for the .wasm file path. When running
 *   in Node/Vitest this defaults to the dist/ directory next to the Go
 *   module. In Cloudflare Workers the caller should pass the imported WASM
 *   module binding.
 */
export async function initWasm(
  wasmPath?: string | WebAssembly.Module,
): Promise<ApertureWasm> {
  if (wasmInstance) return wasmInstance;
  if (initPromise) return initPromise;

  initPromise = doInit(wasmPath);
  wasmInstance = await initPromise;
  return wasmInstance;
}

/** Returns the already-initialized WASM instance or throws. */
export function getWasm(): ApertureWasm {
  if (!wasmInstance) {
    throw new Error(
      "WASM not initialized. Call initWasm() before using macaroon operations.",
    );
  }
  return wasmInstance;
}

async function doInit(
  wasmPathOrModule?: string | WebAssembly.Module,
): Promise<ApertureWasm> {
  // Load the Go wasm_exec.js runtime shim. It attaches a global `Go` class.
  const wasmDir = resolveWasmDir();

  // In Node/Vitest, we need to load wasm_exec.js. In CF Workers, the Go
  // class may already be available.
  if (typeof (globalThis as any).Go === "undefined") {
    const wasmExecPath = join(wasmDir, "wasm_exec.js");
    // Dynamic import of the wasm_exec.js shim which defines globalThis.Go.
    await import(wasmExecPath);
  }

  const GoClass = (globalThis as any).Go;
  if (!GoClass) {
    throw new Error("Go WASM runtime (wasm_exec.js) not loaded.");
  }

  const go = new GoClass();

  let instance: WebAssembly.Instance;

  if (wasmPathOrModule instanceof WebAssembly.Module) {
    // CF Workers pass a pre-compiled WebAssembly.Module.
    instance = await WebAssembly.instantiate(
      wasmPathOrModule,
      go.importObject,
    );
  } else {
    // Node/test path: read .wasm from disk.
    const wasmFilePath = wasmPathOrModule ?? join(wasmDir, "aperture.wasm");
    const wasmBuffer = await readFile(wasmFilePath);
    const result = await WebAssembly.instantiate(
      wasmBuffer,
      go.importObject,
    );
    instance = result.instance;
  }

  // Start the Go program (it blocks in `select {}` so this returns
  // immediately after registration).
  go.run(instance);

  // The Go bridge registers itself as globalThis.apertureWasm.
  const bridge = (globalThis as any).apertureWasm as ApertureWasm | undefined;
  if (!bridge) {
    throw new Error(
      "WASM bridge did not register globalThis.apertureWasm. " +
        "Check that bridge.go is compiled correctly.",
    );
  }

  return bridge;
}

function resolveWasmDir(): string {
  // Resolve the wasm dist/ directory relative to this file.
  // In the monorepo: packages/core/src/macaroon/wasm.ts
  // WASM dir: packages/wasm/dist/
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // From src/macaroon/ -> ../../.. -> packages/ -> wasm/dist/
    return join(thisDir, "..", "..", "..", "wasm", "dist");
  } catch {
    // Fallback for environments where import.meta.url isn't a file:// URL.
    return join(process.cwd(), "packages", "wasm", "dist");
  }
}
