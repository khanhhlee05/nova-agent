import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/content.ts",
      formats: ["iife"],
      name: "NovaAgent",
      fileName: () => "nova-agent.iife.js",
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
