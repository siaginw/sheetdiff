export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // apply committed migrations before anything reads the DB — makes
  // `git pull && restart` the complete upgrade procedure
  const { ensureMigrated } = await import("./lib/db/migrate");
  try {
    ensureMigrated();
  } catch (err) {
    // fail closed: a drifted schema must not serve requests or run captures
    console.error("[migrate] FATAL:", err instanceof Error ? err.message : err);
    throw err;
  }
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
