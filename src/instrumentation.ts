export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // apply committed migrations before anything reads the DB — makes
  // `git pull && restart` the complete upgrade procedure
  const { ensureMigrated } = await import("./lib/db/migrate");
  try {
    ensureMigrated();
  } catch (err) {
    // fail closed: a drifted schema must not serve requests or run captures
    const { logger } = await import("./lib/logger");
    logger.error({ err: err instanceof Error ? err.message : err }, "[migrate] FATAL");
    throw err;
  }
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
