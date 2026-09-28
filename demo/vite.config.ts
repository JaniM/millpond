import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Run with `pnpm demo` (vite's root is demo/). The demo imports the library
// straight from ../src, so edits to the engine hot-reload without a build.
export default defineConfig({
  plugins: [react()],
});
