import { sqliteTable, text, integer, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // uuid
  googleSub: text("google_sub").notNull().unique(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  // Encrypted JSON: { refresh_token, access_token, expiry_date }
  tokensEnc: text("tokens_enc").notNull(),
  // Daily digest email (null = digest off)
  digestEmail: text("digest_email"),
  digestTime: text("digest_time").notNull().default("07:00"), // "HH:MM" local
  lastDigestAt: integer("last_digest_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export type ScheduleKind = "off" | "hourly" | "daily" | "weekly";

export const spreadsheets = sqliteTable("spreadsheets", {
  id: text("id").primaryKey(), // uuid
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  googleId: text("google_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  // Snapshot schedule
  scheduleKind: text("schedule_kind", { enum: ["off", "hourly", "daily", "weekly"] })
    .notNull()
    .default("off"),
  scheduleHours: integer("schedule_hours"), // for hourly: every N hours
  scheduleTime: text("schedule_time"), // "HH:MM" for daily/weekly
  scheduleDay: integer("schedule_day"), // 0=Sun..6=Sat, for weekly
  nextRunAt: integer("next_run_at", { mode: "number" }),
  lastSnapshotAt: integer("last_snapshot_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const tabs = sqliteTable(
  "tabs",
  {
    id: text("id").primaryKey(), // uuid
    spreadsheetId: text("spreadsheet_id")
      .notNull()
      .references(() => spreadsheets.id, { onDelete: "cascade" }),
    title: text("title").notNull(), // Google tab name
    position: integer("position").notNull().default(0),
    tracked: integer("tracked", { mode: "boolean" }).notNull().default(true),
    // 0-based column index used to match rows across snapshots.
    // null = auto-detect at diff time.
    keyColumn: integer("key_column"),
  },
  (t) => [uniqueIndex("tabs_spreadsheet_title_idx").on(t.spreadsheetId, t.title)],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(), // uuid
    tabId: text("tab_id")
      .notNull()
      .references(() => tabs.id, { onDelete: "cascade" }),
    // Groups the per-tab snapshots taken in one capture run
    runId: text("run_id").notNull(),
    trigger: text("trigger", { enum: ["manual", "scheduled", "import"] }).notNull(),
    isBaseline: integer("is_baseline", { mode: "boolean" }).notNull().default(false),
    rowCount: integer("row_count").notNull(),
    colCount: integer("col_count").notNull(),
    // gzip'd JSON: { headers: string[], rows: string[][] }
    dataBlob: blob("data_blob", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("snapshots_tab_created_idx").on(t.tabId, t.createdAt),
    index("snapshots_run_idx").on(t.runId),
  ],
);

export type User = typeof users.$inferSelect;
export type Spreadsheet = typeof spreadsheets.$inferSelect;
export type Tab = typeof tabs.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;

/**
 * Audit notes: scoped to a whole snapshot run (timeline note), to a tab, or to
 * a specific changed row (rowKey matches DiffRow.rowKey).
 */
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    spreadsheetId: text("spreadsheet_id")
      .notNull()
      .references(() => spreadsheets.id, { onDelete: "cascade" }),
    tabId: text("tab_id").references(() => tabs.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    rowKey: text("row_key"),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("notes_sheet_created_idx").on(t.spreadsheetId, t.createdAt)],
);

/**
 * Per-change "synced downstream" acknowledgments. A change (tab + rowKey) is
 * resolved when its ack is NEWER than the snapshot that introduced the change.
 */
export const changeAcks = sqliteTable(
  "change_acks",
  {
    id: text("id").primaryKey(),
    tabId: text("tab_id")
      .notNull()
      .references(() => tabs.id, { onDelete: "cascade" }),
    rowKey: text("row_key").notNull(),
    ackedAt: integer("acked_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("change_acks_tab_row_idx").on(t.tabId, t.rowKey)],
);

export type Note = typeof notes.$inferSelect;
export type ChangeAck = typeof changeAcks.$inferSelect;
