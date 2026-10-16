/**
 * Seeded-environment flows. The e2e stack's `prisma migrate reset` runs the
 * configured seed (package.json prisma.seed), so the demo account's project
 * (octocat/sample-app #42) exists with three runs — including a failed run on
 * the PR's current head (commit prefix abc1230) — and its auto-opened incident.
 * These tests pin the surfaces the external UI suite flagged: the PR overview
 * card run badge, the Settings System status section, the Test Runs list with
 * status and commit-SHA filters, and the failed-run incident linkage.
 */
import { test, expect, type Page } from "@playwright/test";

const demo = { email: "demo@devsentinel.example", password: "DemoPassw0rd" };

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(demo.email);
  await page.getByLabel("Password", { exact: true }).fill(demo.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/app");
}

test("pull request overview card shows the latest run status", async ({ page }) => {
  await login(page);
  await page.goto("/app/pull-requests");
  const card = page.locator("a", { hasText: "octocat/sample-app #42" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Latest run:")).toBeVisible();
  await expect(card.locator('span:text-is("passed")')).toBeVisible();
});

test("settings page shows the System status section", async ({ page }) => {
  await login(page);
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
  await expect(page.getByText("Background worker:")).toBeVisible();
  await expect(page.getByText("GitHub webhook:")).toBeVisible();
  await expect(page.getByText("TestSprite CLI:")).toBeVisible();
});

test("test runs page lists seeded runs and honors status and SHA filters", async ({ page }) => {
  await login(page);

  await page.goto("/app/runs");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByText("No test runs match")).toBeHidden();

  // Status filter: exactly the seeded failed run, on the PR's current head.
  await page.locator("#f-project").selectOption({ label: "Sample App" });
  await page.locator("#f-status").selectOption("failed");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  const failedRow = page.locator("tbody tr").first();
  await expect(failedRow).toContainText("abc1230");
  await expect(failedRow.locator('span:text-is("failed")')).toBeVisible();

  // Commit-SHA binding: a prefix search resolves both runs on that commit.
  await page.goto("/app/runs?sha=abc123");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // The failed run's detail shows the provider summary honestly labeled.
  await page.locator("tbody tr", { hasText: "failed" }).first().getByRole("link").first().click();
  await expect(page.getByText("10/12 passed, 2 failed")).toBeVisible();
  await expect(page.getByText("Simulated demonstration")).toBeVisible();
  await expect(page.getByText("2 of 12 checks failed on commit abc1230.")).toBeVisible();
});

test("failed seeded run is linked to an open incident", async ({ page }) => {
  await login(page);
  await page.goto("/app/incidents");
  const card = page.locator("a", { hasText: "sample-app #42" });
  await expect(card).toBeVisible();
  await expect(card.locator('span:text-is("high")')).toBeVisible();
  await expect(card.locator('span:text-is("open")')).toBeVisible();
  await expect(page.getByText("No incidents")).toBeHidden();
});
