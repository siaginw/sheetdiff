/**
 * Dev-only demo data: seeds a fake user + sheet + two snapshots so the whole
 * diff pipeline can be explored WITHOUT connecting Google. Safe to re-run.
 * After running, sign in as the demo user at http://localhost:3000/auth/demo
 *
 * The data mirrors a real audit: run 1 has the classic errors (wrong ending
 * station creating a 2 ft gap, a shot entered twice as plow AND bore), run 2
 * is "after the audit" with everything fixed.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import Database from "better-sqlite3";

const db = new Database("data/sheetdiff.db");
db.pragma("journal_mode = WAL");

const enc = (data) => zlib.gzipSync(Buffer.from(JSON.stringify(data)));
const now = Date.now();
const HOUR = 3_600_000;

db.exec("DELETE FROM change_acks; DELETE FROM notes; DELETE FROM snapshots; DELETE FROM tabs; DELETE FROM spreadsheets; DELETE FROM users;");

const userId = crypto.randomUUID();
db.prepare(
  "INSERT INTO users (id, google_sub, email, name, avatar_url, tokens_enc, created_at) VALUES (?,?,?,?,?,?,?)",
).run(userId, "smoke-fake-sub", "smoke@test.local", "Smoke Tester", null, "not-real-tokens", now);

const sheetId = crypto.randomUUID();
db.prepare(
  "INSERT INTO spreadsheets (id, user_id, google_id, title, url, schedule_kind, last_snapshot_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
).run(sheetId, userId, "fakeGoogleId123", "US2 Daily Production", "https://docs.google.com/spreadsheets/d/fakeGoogleId123/edit", "off", now - 1 * HOUR, now - 48 * HOUR);

const HEADERS = ["Shot", "Start Station", "End Station", "Type"];

const tabPE4 = crypto.randomUUID();
const tabPE7 = crypto.randomUUID();
db.prepare("INSERT INTO tabs (id, spreadsheet_id, title, position, tracked, key_column) VALUES (?,?,?,0,1,0)").run(tabPE4, sheetId, "PE4");
db.prepare("INSERT INTO tabs (id, spreadsheet_id, title, position, tracked, key_column) VALUES (?,?,?,1,1,0)").run(tabPE7, sheetId, "PE7");

// run 1 (yesterday, BEFORE the audit): S3 ends at 15741 (wrong — should be
// 15743, creating a 2 ft gap before S4), S3 is entered twice (plow + bore),
// S5 ends 164+80 instead of 164+82.
const run1 = crypto.randomUUID();
db.prepare(
  "INSERT INTO snapshots (id, tab_id, run_id, trigger, is_baseline, row_count, col_count, data_blob, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run(
  crypto.randomUUID(), tabPE4, run1, "scheduled", 1, 6, 4,
  enc({
    headers: HEADERS,
    rows: [
      ["S1", "0", "500", "plow"],
      ["S2", "500", "14800", "bore"],
      ["S3", "14800", "15741", "plow"],
      ["S3", "14800", "15741", "bore"],
      ["S4", "15743", "16000", "plow"],
      ["S5", "16000", "164+80", "bore"],
    ],
  }),
  now - 26 * HOUR,
);

// run 2 (an hour ago, AFTER the audit): dup removed, stations fixed —
// "everything in sheets should be up to par now"
const run2 = crypto.randomUUID();
db.prepare(
  "INSERT INTO snapshots (id, tab_id, run_id, trigger, is_baseline, row_count, col_count, data_blob, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run(
  crypto.randomUUID(), tabPE4, run2, "manual", 0, 5, 4,
  enc({
    headers: HEADERS,
    rows: [
      ["S1", "0", "500", "plow"],
      ["S2", "500", "14800", "bore"],
      ["S3", "14800", "15743", "plow"],
      ["S4", "15743", "16000", "plow"],
      ["S5", "16000", "164+82", "bore"],
    ],
  }),
  now - 1 * HOUR,
);

// PE7 also carries S5 — the classic "shows up in both" from the audit notes.
db.prepare(
  "INSERT INTO snapshots (id, tab_id, run_id, trigger, is_baseline, row_count, col_count, data_blob, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run(
  crypto.randomUUID(), tabPE7, crypto.randomUUID(), "scheduled", 1, 1, 4,
  enc({
    headers: HEADERS,
    rows: [["S5", "16000", "164+82", "bore"]],
  }),
  now - 20 * HOUR,
);



// viewer demo user: member of the owner's workspace (sign in at /auth/demo?as=viewer)
const viewerId = crypto.randomUUID();
db.prepare(
  "INSERT INTO users (id, google_sub, email, name, avatar_url, tokens_enc, created_at) VALUES (?,?,?,?,?,?,?)",
).run(viewerId, "viewer-fake-sub", "viewer@test.local", "Erin (viewer)", null, "not-real-tokens", now);
db.prepare(
  "INSERT INTO members (id, owner_user_id, email, created_at) VALUES (?,?,?,?)",
).run(crypto.randomUUID(), userId, "viewer@test.local", now);

console.log("SEED_OK");
console.log(
  "Demo login is opt-in: set ENABLE_DEMO=1 in .env, restart the app, then open http://localhost:3000/auth/demo",
);
