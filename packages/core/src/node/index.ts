/**
 * Node-only entry point.
 *
 * Everything that needs node:fs, node:path or import.meta.url lives here
 * rather than in the main entry, so bundling @lightninglabs/aperture-core for Cloudflare
 * Workers never has to resolve a Node builtin. Import this from
 * "@lightninglabs/aperture-core/node"; a Worker bundle should never reach it.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { initWasm, type ApertureWasm } from "../macaroon/wasm.js";

export interface InitWasmFromDiskOptions {
  /** Directory holding aperture.wasm and wasm_exec.js. */
  wasmDir?: string;
  /** Path to the .wasm file, if it does not sit in wasmDir. */
  wasmPath?: string;
}

/**
 * Initialize the WASM bridge by reading it off disk, loading the Go
 * runtime shim first. This is the convenience path for Node and Vitest;
 * Workers pass their imported module binding to initWasm() directly.
 */
export async function initWasmFromDisk(
  opts: InitWasmFromDiskOptions = {},
): Promise<ApertureWasm> {
  const wasmDir = opts.wasmDir ?? resolveWasmDir();

  // wasm_exec.js defines globalThis.Go as a side effect. It is a plain
  // script, so it has no exports to bind, and importing it twice is
  // harmless.
  if (typeof (globalThis as Record<string, unknown>).Go === "undefined") {
    await import(join(wasmDir, "wasm_exec.js"));
  }

  const wasmPath = opts.wasmPath ?? join(wasmDir, "aperture.wasm");
  const bytes = await readFile(wasmPath);

  return initWasm(bytes);
}

/** Locate packages/wasm/dist relative to this module. */
function resolveWasmDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));

    // Built layout is packages/core/dist/node/index.js, source layout is
    // packages/core/src/node/index.ts. Both sit two levels under the
    // package root, so the same hop reaches packages/wasm/dist.
    return join(thisDir, "..", "..", "..", "wasm", "dist");
  } catch {
    // Fallback for environments where import.meta.url is not a file URL.
    return join(process.cwd(), "packages", "wasm", "dist");
  }
}
