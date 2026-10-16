import { defineConfig } from "@playwright/test";
import path from "node:path";

const port = 3311;
const root = __dirname;

export default defineConfig({
  testDir: path.join(root, "tests/e2e"),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bash tests/e2e/start-stack.sh",
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 420_000,
    env: {
      ...process.env,
      // Postgres test database (created automatically if missing; see tests/e2e/start-stack.sh).
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:5432/devsentinel_e2e`,
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
      APP_BASE_URL: `http://localhost:${port}`,
      GITHUB_WEBHOOK_SECRET: "whsec_e2e_local",
      // No real GitHub in E2E: skip the repository-access proof (test stack only; see repoProofBypassedForTests).
      DEVSENTINEL_E2E_SKIP_REPO_PROOF: "i-understand-this-disables-access-checks",
      // E2E uses the mock CLI fixture (spec 20: E2E against mocks).
      TESTSPRITE_CLI_PATH: path.join(root, "tests/e2e/fixtures/fake-testsprite.cjs"),
      WORKER_POLL_INTERVAL_MS: "500",
      WORKER_CONCURRENCY: "2",
    },
  },
});
