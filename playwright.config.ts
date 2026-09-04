import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * Smoke E2E against the PRODUCTION build (what CI ships), booted on its own
 * port with a THROWAWAY database in the OS temp dir — E2E can never touch a
 * real DATABASE_PATH. The demo login (ENABLE_DEMO=1) is the OAuth escape
 * hatch; the seed's own guard refuses to run when non-demo users exist, so
 * the chain can't nuke real data even if paths were misconfigured.
 */
const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = `http://localhost:${PORT}`;
const dbPath = path.join(os.tmpdir(), `sheetdiff-e2e-${process.pid}.db`);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined, // the CI recommendation from the Playwright docs
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // migrate (CLI) -> seed the demo story -> boot. The app's boot migration
    // then no-ops: the journal is already stamped, so two migrators never race.
    command: "npm run db:migrate && npm run seed-demo && npm run start",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    env: {
      // setting env REPLACES process.env — spread it explicitly
      ...process.env,
      PORT,
      DATABASE_PATH: dbPath,
      ENABLE_DEMO: "1",
      APP_SECRET: "e2e-session-signing-key-not-secret",
    },
  },
});
