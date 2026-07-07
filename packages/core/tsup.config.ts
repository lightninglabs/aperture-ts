import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/auth/index.ts",
    "src/macaroon/index.ts",
    "src/pricing/index.ts",
    "src/receipts/index.ts",
    "src/policy/index.ts",
    "src/util/index.ts",
  ],
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  sourcemap: true,
  clean: true,
  target: "esnext",
});
