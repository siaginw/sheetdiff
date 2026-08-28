import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./db/schema";
import { encryptJson, decryptJson } from "./crypto";

export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

export interface StoredTokens {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function getRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
}

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri(),
  );
}

export function generateAuthUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline", // needed to receive a refresh token
    scope: SCOPES,
    state,
    prompt: "consent",
  });
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Exchange an authorization code for tokens + the signed-in profile. */
export async function exchangeCode(code: string): Promise<{ tokens: StoredTokens; profile: GoogleProfile }> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const res = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  const p = res.data;
  return {
    tokens: {
      refresh_token: tokens.refresh_token ?? null,
      access_token: tokens.access_token ?? null,
      expiry_date: tokens.expiry_date ?? null,
    },
    profile: {
      sub: String(p.id),
      email: p.email ?? null,
      name: p.name ?? null,
      picture: p.picture ?? null,
    },
  };
}

/**
 * OAuth client for a stored user. Persists refreshed tokens so access-token
 * rotation survives restarts.
 */
export async function getUserClient(userId: string): Promise<OAuth2Client> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new Error("User not found");
  const client = createOAuthClient();
  const stored = decryptJson<StoredTokens>(user.tokensEnc);
  client.setCredentials({
    refresh_token: stored.refresh_token ?? undefined,
    access_token: stored.access_token ?? undefined,
    expiry_date: stored.expiry_date ?? undefined,
  });
  client.on("tokens", async (updated) => {
    try {
      const next: StoredTokens = {
        refresh_token: updated.refresh_token ?? stored.refresh_token ?? null,
        access_token: updated.access_token ?? null,
        expiry_date: updated.expiry_date ?? null,
      };
      await db
        .update(users)
        .set({ tokensEnc: encryptJson(next) })
        .where(eq(users.id, userId));
    } catch (err) {
      console.error("Failed to persist refreshed Google tokens:", err);
    }
  });
  return client;
}

/** Extract the spreadsheet id from any Google Sheets URL (or a bare id). */
export function parseSpreadsheetId(input: string): string | null {
  const t = input.trim();
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t;
  const m =
    t.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) ??
    t.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

export interface SheetTabInfo {
  title: string;
  sheetId: number;
}

/** Spreadsheet title + tab list (no grid data). */
export async function fetchSpreadsheetMeta(
  client: OAuth2Client,
  spreadsheetId: string,
): Promise<{ title: string; tabs: SheetTabInfo[] }> {
  const sheets = google.sheets({ version: "v4", auth: client });
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(sheetId,title)",
  });
  const tabs = (res.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? "",
    sheetId: s.properties?.sheetId ?? -1,
  }));
  return { title: res.data.properties?.title ?? "Untitled spreadsheet", tabs };
}

/** Fetch all values of the given tabs. Returns raw grids keyed by tab title. */
export async function fetchTabValues(
  client: OAuth2Client,
  spreadsheetId: string,
  tabTitles: string[],
): Promise<Record<string, string[][]>> {
  if (tabTitles.length === 0) return {};
  const sheets = google.sheets({ version: "v4", auth: client });
  // Quotes are required around tab names containing spaces/special characters.
  const ranges = tabTitles.map((t) => `'${t.replace(/'/g, "''")}'`);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  const out: Record<string, string[][]> = {};
  (res.data.valueRanges ?? []).forEach((vr, i) => {
    out[tabTitles[i]] = (vr.values ?? []) as string[][];
  });
  return out;
}
