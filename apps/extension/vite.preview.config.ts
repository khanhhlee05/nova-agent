import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Development harness: renders the side panel with a stub host at
// http://localhost:5174/preview.html?scenario=<name>. Used for manual review
// and for the screenshot script. Not part of the shipped extension.
export default defineConfig({
  root: resolve(__dirname, "dev"),
  publicDir: resolve(__dirname, "public"),
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
