/**
 * /auth/demo — the no-credential login. It must work on a demo-only database
 * and REFUSE one that ever gained real users (ENABLE_DEMO left on after
 * production-izing would otherwise expose a LAN-reachable login).
 * Standard temp-DATABASE_PATH harness; schema via the repo's own migrator.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setupMigratedTempDb } from "@/test/db-harness";

setupMigratedTempDb("demo");

const { db } = await import("@/lib/db");
const { users } = await import("@/lib/db/schema");
const { GET } = await import("./route");

const seedDemoUser = () =>
  db.insert(users).values({
    id: "demo-1", googleSub: "smoke-fake-sub", email: "smoke@test.local", name: "Smoke",
    tokensEnc: "x", createdAt: 1,
  });

beforeEach(async () => {
  process.env.ENABLE_DEMO = "1";
  await db.delete(users);
});

describe("GET /auth/demo", () => {
  it("signs into the demo account on a demo-only database", async () => {
    await seedDemoUser();
    const res = await GET(new Request("http://localhost/auth/demo"));
    expect(res.status).toBe(307);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sd_session=");
  });

  it("REFUSES once a real (non-demo) user exists — even with ENABLE_DEMO=1", async () => {
    await seedDemoUser();
    await db.insert(users).values({
      id: "real-1", googleSub: "real-sub", email: "erin@company.com", name: "Erin",
      tokensEnc: "x", createdAt: 2,
    });
    const res = await GET(new Request("http://localhost/auth/demo"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("error=demo-disabled");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("sd_session=");
  });

  it("refuses when the flag is off", async () => {
    await seedDemoUser();
    process.env.ENABLE_DEMO = "0";
    const res = await GET(new Request("http://localhost/auth/demo"));
    expect(res.headers.get("location")).toContain("error=demo-disabled");
  });
});
