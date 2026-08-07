/**
 * WASM loader and TypeScript wrapper for the Go-compiled L402 macaroon
 * bridge. Exposes typed functions for minting, verifying, and manipulating
 * macaroons.
 *
 * This module is runtime-agnostic on purpose: it never touches node:fs,
 * node:path or import.meta.url, so it bundles cleanly for Cloudflare
 * Workers. The caller supplies the compiled module or its bytes. Node
 * callers who want the old read-it-off-disk behaviour should use
 * `initWasmFromDisk` from "@aperture/core/node".
 */

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
 * instantiated only once. Returns the typed bridge interface.
 *
 * Two things must be in place before this runs. `globalThis.Go` has to be
 * defined, which means the caller has already loaded the `wasm_exec.js`
 * shim that ships next to `aperture.wasm`. And `source` has to be the
 * compiled module or its bytes: in a Worker that is the imported `.wasm`
 * module binding, in Node it is the file contents.
 *
 * Note that in Cloudflare Workers this cannot be called at module scope.
 * The Go runtime schedules a timer during startup, and workerd only allows
 * timers inside a request context, so initialize lazily on first request.
 *
 * @param source The compiled WebAssembly module, or the raw module bytes.
 */
export async function initWasm(
  source: WebAssembly.Module | BufferSource,
): Promise<ApertureWasm> {
  if (wasmInstance) return wasmInstance;
  if (initPromise) return initPromise;

  initPromise = doInit(source);

  try {
    wasmInstance = await initPromise;
  } catch (err) {
    // Do not cache a failed attempt: a caller that fixes the input and
    // retries should get a real second attempt rather than the first
    // rejection forever.
    initPromise = null;
    throw err;
  }

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
  source: WebAssembly.Module | BufferSource,
): Promise<ApertureWasm> {
  // wasm_exec.js is the Go runtime shim that defines globalThis.Go. It is
  // a side-effecting script rather than a module with exports, so the
  // caller loads it: in a Worker as a bare `import` of the vendored file,
  // in Node via initWasmFromDisk.
  const GoClass = (globalThis as Record<string, any>).Go;
  if (!GoClass) {
    throw new Error(
      "Go WASM runtime not loaded: globalThis.Go is undefined. Import " +
        "the wasm_exec.js that ships alongside aperture.wasm before " +
        "calling initWasm().",
    );
  }

  if (!source) {
    throw new Error(
      "initWasm() requires the compiled module or its bytes. In a Worker, " +
        'pass the imported .wasm module binding; in Node, use ' +
        'initWasmFromDisk() from "@aperture/core/node".',
    );
  }

  const go = new GoClass();

  // WebAssembly.instantiate is overloaded: given a Module it resolves to
  // an Instance, given bytes it resolves to { module, instance }.
  const instantiated = await WebAssembly.instantiate(
    source as WebAssembly.Module,
    go.importObject,
  );
  const instance =
    instantiated instanceof WebAssembly.Instance
      ? instantiated
      : (instantiated as WebAssembly.WebAssemblyInstantiatedSource).instance;

  // Start the Go program. bridge.go blocks in `select {}` to keep the
  // instance alive after registering its exports, so go.run() never
  // resolves and must not be awaited.
  void go.run(instance);

  // The Go bridge registers itself as globalThis.apertureWasm.
  const bridge = (globalThis as Record<string, any>).apertureWasm as
    | ApertureWasm
    | undefined;
  if (!bridge) {
    throw new Error(
      "WASM bridge did not register globalThis.apertureWasm. " +
        "Check that bridge.go is compiled correctly.",
    );
  }

  return bridge;
}
