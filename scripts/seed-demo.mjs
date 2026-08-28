/**
 * Dev-only demo data: seeds a fake user + sheet + two snapshots so the whole
 * diff pipeline can be explored WITHOUT connecting Google. Safe to re-run.
 * After running, sign in as the demo user at http://localhost:3000/auth/demo
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import Database from "better-sqlite3";

const db = new Database("data/sheetdiff.db");
db.pragma("journal_mode = WAL");

const enc = (data) => zlib.gzipSync(Buffer.from(JSON.stringify(data)));
const now = Date.now();
const HOUR = 3_600_000;

// wipe previous smoke data
db.exec("DELETE FROM snapshots; DELETE FROM tabs; DELETE FROM spreadsheets; DELETE FROM users;");

const userId = crypto.randomUUID();
db.prepare(
  "INSERT INTO users (id, google_sub, email, name, avatar_url, tokens_enc, created_at) VALUES (?,?,?,?,?,?,?)",
).run(userId, "smoke-fake-sub", "smoke@test.local", "Smoke Tester", null, "not-real-tokens", now);

const sheetId = crypto.randomUUID();
db.prepare(
  "INSERT INTO spreadsheets (id, user_id, google_id, title, url, schedule_kind, last_snapshot_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
).run(sheetId, userId, "fakeGoogleId123", "Daily Production Log", "https://docs.google.com/spreadsheets/d/fakeGoogleId123/edit", "off", now - 1 * HOUR, now - 48 * HOUR);

const tabId = crypto.randomUUID();
db.prepare(
  "INSERT INTO tabs (id, spreadsheet_id, title, position, tracked, key_column) VALUES (?,?,?,0,1,NULL)",
).run(tabId, sheetId, "Entries");

// run 1 (yesterday, baseline): 4 rows
const run1 = crypto.randomUUID();
db.prepare(
  "INSERT INTO snapshots (id, tab_id, run_id, trigger, is_baseline, row_count, col_count, data_blob, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run(
  crypto.randomUUID(), tabId, run1, "scheduled", 1, 4, 4,
  enc({
    headers: ["ID", "Crew", "Task", "Qty"],
    rows: [
      ["1", "Jake", "Framing", "40"],
      ["2", "Ana", "Electrical", "100"],
      ["3", "Mo", "Plumbing", "55"],
      ["4", "Bea", "Drywall", "12"],
    ],
  }),
  now - 26 * HOUR,
);

// run 2 (an hour ago): qty fixed 40->55 (numeric noise 100->"100.00"), row 3 removed, row 5 added, rows sorted
const run2 = crypto.randomUUID();
db.prepare(
  "INSERT INTO snapshots (id, tab_id, run_id, trigger, is_baseline, row_count, col_count, data_blob, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
).run(
  crypto.randomUUID(), tabId, run2, "manual", 0, 4, 4,
  enc({
    headers: ["ID", "Crew", "Task", "Qty"],
    rows: [
      ["4", "Bea", "Drywall", "12"],
      ["1", "Jake", "Framing", "55"],
      ["2", "Ana", "Electrical", "100.00"],
      ["5", "Kim", "Paint", "30"],
    ],
  }),
  now - 1 * HOUR,
);

console.log("SEED_OK");
console.log("Open http://localhost:3000/auth/demo to sign in as the demo user.");
