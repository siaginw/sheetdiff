import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env");

if (fs.existsSync(envPath)) {
  console.log(".env already exists — nothing to do.");
  process.exit(0);
}

const env = `# SheetDiff local configuration (generated)
# Encrypts Google tokens at rest. Never share or commit this value.
APP_SECRET=${crypto.randomBytes(32).toString("hex")}

# Google OAuth — see README.md for the 10-minute walkthrough.
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Must exactly match an "Authorized redirect URI" in your Google Cloud OAuth client
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback

# Optional: base URL used in digest email links
# APP_URL=http://localhost:3000

# Optional: SMTP for the daily digest email (e.g. Gmail: host smtp.gmail.com, port 587,
# user = your address, pass = an App Password). Digest stays off until configured
# and an address is set in the app's account menu.
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=you@gmail.com
# SMTP_PASS=your-app-password
# DIGEST_FROM=SheetDiff <you@gmail.com>

# Optional: demo login (local exploration only — see README "Try the demo")
# ENABLE_DEMO=1

# Optional: dead-man switch — the scheduler pings this URL each minute;
# set up a free monitor at healthchecks.io to alert when snapshots stop.
# HEALTHCHECK_PING_URL=https://hc-ping.com/your-uuid

# Optional: data maintenance
# SHEETDIFF_KEEP_SNAPSHOTS=200   # newest non-baseline snapshots per tab (0 = keep all)
# SHEETDIFF_BACKUPS=14           # nightly DB backups to keep (0 = off)

# Optional: where the SQLite database lives (default ./data/sheetdiff.db)
# DATABASE_PATH=./data/sheetdiff.db
`;

fs.writeFileSync(envPath, env, "utf8");
console.log("Created .env with a random APP_SECRET.");
console.log("Next: add your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README.md).");

// create the database too, so `npm run dev` works right after
const { spawnSync } = await import("node:child_process");
const push = spawnSync("npx", ["drizzle-kit", "migrate"], { stdio: "inherit", shell: true });
if (push.status !== 0) {
  console.log("Database creation skipped — run `npm run db:migrate` manually.");
} else {
  console.log("Database ready (data/sheetdiff.db).");
}
