import { defineConfig } from "vitest/config";

// Deadline buckets are interpreted in the student's local timezone. Tests pin
// a DST-observing zone so day-boundary and daylight-saving cases are stable.
process.env.TZ = "America/New_York";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    env: { TZ: "America/New_York" },
  },
});
