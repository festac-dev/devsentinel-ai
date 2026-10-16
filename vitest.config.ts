import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 120_000, // migration reset + worker spawns in integration hooks
    // Integration files share one PostgreSQL test database and reset its
    // schema on boot; parallel files would race that reset.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
