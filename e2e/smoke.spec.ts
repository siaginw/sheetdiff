import { expect, test, type Page } from "@playwright/test";

/** The demo login is one GET that sets the session cookie and lands on "/". */
async function demoLogin(page: Page) {
  await page.goto("/auth/demo");
  await expect(page).toHaveURL(/\/$/);
}

test("health endpoint reports ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toMatchObject({ ok: true });
});

test("logged-out visitors see the public landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("version controlled");
});

test("demo login shows the seeded sheet on the dashboard", async ({ page }) => {
  await demoLogin(page);
  await expect(page.getByRole("link", { name: "US2 Daily Production" })).toBeVisible();
});

test("sheet page renders the diff view with its changes-since-collection bar", async ({ page }) => {
  await demoLogin(page);
  await page.getByRole("link", { name: "US2 Daily Production" }).click();
  await expect(page.getByText("History", { exact: false })).toBeVisible();
  // the seeded story has unentered changes since the collection point
  await expect(page.getByText(/to enter/i).first()).toBeVisible();
});

test("report and billing pages render", async ({ page }) => {
  await demoLogin(page);
  await page.getByRole("link", { name: "US2 Daily Production" }).click();
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goBack();
  await page.getByRole("link", { name: "US2 Daily Production" }).click();
  await page.getByRole("button", { name: "Billing day" }).first().click();
  await expect(page.getByText(/billing day/i).first()).toBeVisible();
});
