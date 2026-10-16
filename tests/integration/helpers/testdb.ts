/**
 * Shared PostgreSQL test database for the integration suites (ADR-010).
 * The database is reset (schema dropped, all migrations re-applied, including
 * the immutability trigger) before each test file, so every file starts from
 * the real versioned schema.
 *
 * Point TEST_DATABASE_URL at any throwaway PostgreSQL database; CI provisions
 * one as a service container. Create one locally with:
 *   createdb devsentinel_test
 */
import { execSync } from "node:child_process";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/devsentinel_test";

// 32 raw bytes "0123456789abcdef0123456789abcdef" base64 — test-only key, never production.
const TEST_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

/** Reset + migrate the test database and export the env dynamic imports need. */
export function prepareTestDatabase(): void {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DIRECT_URL = TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY_VERSION = "1";
  try {
    execSync("npx prisma migrate reset --force --skip-generate", { env: process.env, stdio: "pipe" });
  } catch (err) {
    // execSync's own message drops Prisma's output; surface it so CI shows the real cause.
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `prisma migrate reset failed\n${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`
    );
  }
}
