export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // apply committed migrations before anything reads the DB — makes
  // `git pull && restart` the complete upgrade procedure
  const { ensureMigrated } = await import("./lib/db/migrate");
  try {
    ensureMigrated();
  } catch (err) {
    console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  }
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
