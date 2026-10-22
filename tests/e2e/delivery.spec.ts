/**
 * Delivery tracker browser flows. The E2E stack resets the throwaway database
 * and seeds the demo account; the tracker itself is initialized on first visit.
 * These tests use the real Next.js server, server actions, PostgreSQL, and the
 * authenticated session — no mocked tracker state.
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

test("delivery pages require authentication and the report API returns 401", async ({ page, request }) => {
  await page.goto("/app/delivery");
  await expect(page).toHaveURL(/\/login/);
  const response = await request.get("/api/delivery/report");
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
});

test.describe.configure({ mode: "serial" });

test("overview initializes four phases and sixteen reported-complete, unverified tasks", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Delivery Tracker" }).first().click();
  await page.waitForURL("**/app/delivery");

  await expect(page.getByRole("heading", { level: 1, name: "DevSentinel AI" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reported completion and evidence verification are separate" })).toBeVisible();
  await expect(page.getByText("Reported completion (16 of 16)")).toBeVisible();
  await expect(page.getByText("Evidence verified (0 of 16)")).toBeVisible();
  await expect(page.getByText("Not submission-ready", { exact: true }).first()).toBeVisible();

  for (const phase of [
    "Audit and Stabilize",
    "Product Experience",
    "Reliability",
    "Real Integrations",
  ]) {
    await expect(page.getByRole("heading", { name: phase })).toBeVisible();
  }
  await expect(page.getByText("Reported complete", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Unverified", { exact: true }).first()).toBeVisible();
});

test("phase and task pages show an honest unverified state with no invented completion time", async ({ page }) => {
  await login(page);
  await page.goto("/app/delivery/phases/phase-1-audit-stabilize");
  await expect(page.getByRole("heading", { level: 1, name: "Audit and Stabilize" })).toBeVisible();
  await expect(page.getByText("Reported completion (4 of 4 tasks)")).toBeVisible();
  await expect(page.getByText("Evidence verified (0 of 4 tasks)")).toBeVisible();

  await page.getByRole("link", { name: "Run typecheck, lint, tests, and production build" }).click();
  await page.waitForURL("**/app/delivery/tasks/p1-run-quality-gates");
  await expect(page.getByRole("heading", { level: 1, name: "Run typecheck, lint, tests, and production build" })).toBeVisible();
  await expect(page.getByText("This task is", { exact: false })).toBeVisible();
  await expect(page.locator("dt", { hasText: "Completed at" }).locator("..").locator("dd")).toHaveText("—");
  await expect(page.getByText("No evidence attached")).toBeVisible();
  await expect(page.getByText("initial state recorded")).toBeVisible();
});

test("attach a review note, verify it explicitly, and see both states remain distinguishable", async ({ page }) => {
  await login(page);
  await page.goto("/app/delivery/tasks/p2-improve-onboarding-diagnostics");

  await page.locator("#evidenceType").selectOption({ label: "Review note" });
  await page.getByLabel("Title", { exact: true }).fill("Onboarding diagnostics review");
  await page
    .getByLabel("Review note / observed result")
    .fill("Dated owner review: reviewed the onboarding diagnostics surface on 2026-10-22. Scope: UI states and error copy. Result: implemented.");
  await page.getByRole("button", { name: "Attach evidence for review" }).click();
  await expect(page.getByRole("status")).toContainText("does not verify the task", { timeout: 20_000 });
  await expect(page.getByText("Verification pending").first()).toBeVisible();

  await page.getByLabel("Review note", { exact: false }).last().fill("Reviewed the recorded note and source on 2026-10-22.");
  await page.getByRole("button", { name: "Record review decision" }).click();
  await expect(page.getByText("Evidence verified", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Record review decision" })).toBeHidden();
  await expect(page.getByText("This is not an independent third-party audit", { exact: false })).toBeVisible();
  await expect(page.getByText("manual review", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("evidence verified", { exact: true }).first()).toBeVisible();
});

test("report page renders stored state, and the download response is authenticated Markdown", async ({ page }) => {
  await login(page);
  await page.goto("/app/delivery/report");
  await expect(page.getByRole("heading", { level: 1, name: "Delivery and verification report" })).toBeVisible();
  await expect(page.getByText("Current record summary")).toBeVisible();
  await expect(page.locator("pre")).toContainText("## 1. Executive summary");
  await expect(page.locator("pre")).toContainText("Onboarding diagnostics review");
  await expect(page.locator("pre")).toContainText("not submission-ready");

  const response = await page.request.get("/api/delivery/report");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/markdown");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  const body = await response.text();
  expect(body).toContain("# DevSentinel AI — Delivery and Verification Report");
  expect(body).toContain("Onboarding diagnostics review");
  expect(body).toContain("Reported completion is not independent proof");
});

test("an invalid direct task key returns 404 rather than another owner's data", async ({ page }) => {
  await login(page);
  const response = await page.goto("/app/delivery/tasks/not-a-real-task");
  expect(response!.status()).toBe(404);
});
