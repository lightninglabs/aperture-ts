import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "esnext",
  external: ["@aperture/core"],
});
