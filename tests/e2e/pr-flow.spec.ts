/**
 * End-to-end suite (spec 20): the full GitHub PR → TestSprite run → commit-bound
 * result → staleness flow, driven through the real UI and the real webhook
 * endpoint. The TestSprite CLI is the documented mock fixture (spec 20: "full
 * PR→run→result flow against mocks") — no real TestSprite execution happens
 * here; the real-credential path is the same code (src/modules/testsprite).
 */
import { createHmac, randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const WEBHOOK_SECRET = "whsec_e2e_local";
const sha = (prefix: string) => (prefix + "0".repeat(40)).slice(0, 40);

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
}

async function deliverPrEvent(
  request: APIRequestContext,
  opts: { repo: string; number: number; action: string; sha: string }
) {
  const body = JSON.stringify({
    action: opts.action,
    number: opts.number,
    repository: { full_name: `octocat/${opts.repo}`, name: opts.repo, owner: { login: "octocat" } },
    pull_request: {
      head: { sha: opts.sha, ref: "feature" },
      base: { ref: "main" },
      title: `E2E PR #${opts.number}`,
      user: { login: "octocat" },
    },
  });
  return request.post("/api/webhooks/github", {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
    },
    data: body,
  });
}

/** Poll a page by reloading until the locator matches something. */
async function waitForLocator(page: Page, url: string, find: () => ReturnType<Page["locator"]>, timeoutMs = 90_000) {
  await expect
    .poll(
      async () => {
        await page.goto(url);
        return (await find().count()) > 0;
      },
      { timeout: timeoutMs, intervals: [1_000, 2_000, 3_000] }
    )
    .toBe(true);
  await page.goto(url);
}

test.describe.configure({ mode: "serial" });

// Serial tests share one account (each test gets a fresh browser context, so
// later tests log back in with these credentials).
const account = { email: "", password: "Sup3rSecretE2E" };

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/app");
}

test("full PR → TestSprite run → commit-bound result → staleness flow", async ({ page, request }) => {
  account.email = `e2e-${Date.now()}@example.com`;

  // --- Register through the real form ---
  await page.goto("/register");
  await page.getByLabel("Name", { exact: true }).fill("E2E Tester");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();

  // Registration does not sign the user in: they land on the sign-in page with a welcome message.
  await page.waitForURL(/\/login\?registered=/);
  await expect(page.getByText("Your account has been created")).toBeVisible();
  await login(page);

  // --- Create a project through the real form ---
  await page.goto("/app/projects");
  await page.getByLabel("Project name").fill("E2E Demo");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/app\/projects\/[^/]+$/);

  // --- Connect a repository (the webhook pipeline matches on owner/repo) ---
  await page.getByLabel("Repository owner").fill("octocat");
  await page.getByLabel("Repository name").fill("e2e-demo");
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(page.getByRole("button", { name: "Disconnect repository" })).toBeVisible();

  // --- Store a TestSprite credential (encrypted at rest) ---
  await page.getByLabel(/TestSprite API key/).fill("sk-user-e2e-mock-key-0001");
  await page.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByText(/TestSprite API key stored/)).toBeVisible();

  // --- Project settings: TestSprite project id + target URL ---
  // The project ID lives inside the collapsed "Advanced" section.
  await page.locator("summary", { hasText: "Advanced" }).click();
  await page.locator("#testspriteProjectId").fill("proj_ok");
  await page.locator("#testTargetUrl").fill("https://e2e-target.example.com");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Project settings saved.")).toBeVisible();

  // --- GitHub delivers a pull_request opened event (signed like GitHub does) ---
  const shaA = sha("aaaaaaaaaa");
  const opened = await deliverPrEvent(request, { repo: "e2e-demo", number: 5, action: "opened", sha: shaA });
  expect(opened.status()).toBe(200);
  const openedBody = (await opened.json()) as { ok?: boolean; duplicate?: boolean };
  expect(openedBody.ok).toBe(true);

  // --- The run appears in the UI, bound to the exact head SHA, and passes ---
  await waitForLocator(
    page,
    "/app/runs",
    () => page.locator(`tr:has-text("${shaA.slice(0, 7)}") span:text-is("passed")`)
  );

  // The PR page shows the current result for the head SHA.
  await page.goto("/app/pull-requests");
  await page.getByText("octocat/e2e-demo #5").first().click();
  await expect(page.getByText(`Current result for head ${shaA.slice(0, 7)}`)).toBeVisible();
  await expect(page.locator('span:text-is("passed")').first()).toBeVisible();

  // --- A new commit (synchronize) gets its own run; the old run goes stale ---
  const shaB = sha("bbbbbbbbbb");
  const synced = await deliverPrEvent(request, { repo: "e2e-demo", number: 5, action: "synchronize", sha: shaB });
  expect(synced.status()).toBe(200);

  // The new head's run completes (same completion wait as run A).
  await waitForLocator(
    page,
    "/app/runs",
    () => page.locator(`tr:has-text("${shaB.slice(0, 7)}") span:text-is("passed")`)
  );

  // The PR detail page marks the old run stale once the head moves to shaB.
  await page.goto("/app/pull-requests");
  await page.getByText("octocat/e2e-demo #5").first().click();
  await expect(page.getByText(`Current result for head ${shaB.slice(0, 7)}`)).toBeVisible();
  await expect(page.locator('span:text-is("Stale")').first()).toBeVisible();
  await expect(
    page.getByTitle(`Tested commit ${shaA.slice(0, 7)}; current head is ${shaB.slice(0, 7)}`)
  ).toBeVisible();
});

test("failing run opens an incident with evidence and notifies", async ({ page, request }) => {
  await login(page);
  // Second project whose TestSprite project id ("fail-…") makes the mock CLI fail.
  await page.goto("/app/projects");
  await page.getByLabel("Project name").fill("E2E Failing");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/app\/projects\/[^/]+$/);

  await page.getByLabel("Repository owner").fill("octocat");
  await page.getByLabel("Repository name").fill("e2e-fail");
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(page.getByRole("button", { name: "Disconnect repository" })).toBeVisible();

  await page.getByLabel(/TestSprite API key/).fill("sk-user-e2e-mock-key-0002");
  await page.getByRole("button", { name: "Save API key" }).click();
  await expect(page.getByText(/TestSprite API key stored/)).toBeVisible();

  // The project ID lives inside the collapsed "Advanced" section.
  await page.locator("summary", { hasText: "Advanced" }).click();
  await page.locator("#testspriteProjectId").fill("fail-proj");
  await page.locator("#testTargetUrl").fill("https://e2e-target.example.com");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Project settings saved.")).toBeVisible();

  const shaF = sha("cccccccccc");
  const res = await deliverPrEvent(request, { repo: "e2e-fail", number: 9, action: "opened", sha: shaF });
  expect(res.status()).toBe(200);

  await waitForLocator(
    page,
    "/app/runs",
    () => page.locator(`tr:has-text("${shaF.slice(0, 7)}") span:text-is("failed")`)
  );

  // Incident auto-created from the verified failing run (project rule on by default).
  await waitForLocator(page, "/app/incidents", () => page.getByText("e2e-fail #9").first(), 60_000);

  // Notification about the failed run exists; mark everything read.
  await waitForLocator(page, "/app/notifications", () => page.getByText("Test run failed").first(), 60_000);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByText(/0 unread/)).toBeVisible();
});

test("monitoring runs a real HTTP check and reports health honestly", async ({ page }) => {
  await login(page);
  await page.goto("/app/monitoring");
  await page.locator("#m-name").fill("Example.com");
  await page.locator("#m-url").fill("https://example.com/");
  await page.getByRole("button", { name: "Create target" }).click();
  await expect(page.getByText("Target created.")).toBeVisible();

  await page.getByRole("button", { name: "Run check now" }).click();
  await waitForLocator(page, "/app/monitoring", () => page.locator('span:text-is("healthy")').first(), 60_000);
  await expect(page.getByText("HTTP 200").first()).toBeVisible();
});

test("bad webhook signatures are rejected", async ({ request }) => {
  const body = JSON.stringify({ action: "opened", number: 1, repository: { full_name: "octocat/e2e-demo" } });
  const res = await request.post("/api/webhooks/github", {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + "0".repeat(64),
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
    },
    data: body,
  });
  expect(res.status()).toBe(401);
});
