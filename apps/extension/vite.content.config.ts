import { defineConfig } from "vite";

// Content scripts cannot use ES module imports at runtime, so bundle as IIFE.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "chrome116",
    lib: {
      entry: "src/content.ts",
      formats: ["iife"],
      name: "NovaAgentContent",
      fileName: () => "content.js",
    },
    rollupOptions: { output: { extend: true } },
  },
});
