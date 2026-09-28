import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  outDir: "dist",
  // react / react-dom are (peer) dependencies, so tsdown externalizes them
  // automatically — no need to list them.
});
