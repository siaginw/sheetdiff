import { DigestSettingsSection } from "@/components/settings/digest-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { savePushSettings, sendTestPush } from "@/lib/actions";
import { users } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/session";
import { ArrowLeft, BellRing, Mail, Server } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

/**
 * The settings hub — every user-level knob in one place. (Sheet-level
 * settings — schedules, key columns, sharing — stay on the sheet they
 * belong to.) Deployer-level knobs (SMTP, APP_URL, capture intervals) are
 * env vars and link to the README table at the bottom.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/auth/login");
  const sp = await searchParams;
  const pushFlash = typeof sp.push === "string" ? sp.push : null;

  // the session row IS the user row — no second query
  const row = user as typeof users.$inferSelect;
  const notifyUrl = row.notifyUrl ?? "";

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground" render={<Link href="/" />}>
          <ArrowLeft className="size-4" /> All sheets
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your notifications live here. Per-sheet settings (schedule, key column, sharing) stay on the sheet.
        </p>

        <section className="mt-8 rounded-xl border bg-card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <BellRing className="size-4" /> Push notifications
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The instant lane: when a snapshot finds <strong>new changes to enter</strong>, your phone buzzes — no app
            signup, no waiting for the digest. Powered by{" "}
            <a
              href="https://ntfy.sh"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              ntfy
            </a>
            .
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              Install the ntfy app (or open <span className="font-mono text-xs">ntfy.sh</span> in a browser).
            </li>
            <li>
              Subscribe to any topic — e.g. <span className="font-mono text-xs">sheetdiff-erin</span>.
            </li>
            <li>
              Paste the topic URL (<span className="font-mono text-xs">https://ntfy.sh/sheetdiff-erin</span>) below.
            </li>
          </ol>
          <form action={savePushSettings} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Label htmlFor="notify-url" className="text-xs text-muted-foreground">
                Topic URL
              </Label>
              <Input
                id="notify-url"
                name="notifyUrl"
                defaultValue={notifyUrl}
                placeholder="https://ntfy.sh/your-topic"
                className="mt-1 font-mono text-sm"
              />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
          {pushFlash === "sent" ? (
            <p className="mt-2 text-sm text-primary">Test sent — check the device that subscribed.</p>
          ) : null}
          {pushFlash === "none" ? <p className="mt-2 text-sm text-destructive">Save a topic URL first.</p> : null}
          {pushFlash === "failed" ? (
            <p className="mt-2 text-sm text-destructive">
              Test failed — the server couldn&apos;t reach that URL (wrong topic, unreachable server, plain http, or a
              private address the SSRF guard refuses; plain http and LAN addresses need NOTIFY_ALLOW_PRIVATE_URLS=1).
            </p>
          ) : null}
          {pushFlash === "invalid" ? (
            <p className="mt-2 text-sm text-destructive">
              That doesn&apos;t look like an http(s) topic URL — it was not saved. (Plain-http topics are refused at
              send time unless NOTIFY_ALLOW_PRIVATE_URLS=1.)
            </p>
          ) : null}
          {notifyUrl ? (
            <form action={sendTestPush} className="mt-3">
              <Button type="submit" variant="ghost" size="sm">
                <BellRing className="size-4" /> Send a test notification
              </Button>
            </form>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            Self-hosting? Run your own ntfy server and paste its topic URL instead — nothing about ntfy.sh is required.
          </p>
        </section>

        <section className="mt-4 rounded-xl border bg-card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Mail className="size-4" /> Daily/weekly digest email
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The summary lane: everything waiting to be entered, once a day or once a week.
          </p>
          <div className="mt-3">
            <DigestSettingsSection
              digestEmail={row?.digestEmail ?? null}
              digestTime={row?.digestTime ?? "07:00"}
              digestDay={row?.digestDay ?? null}
              smtpReady={Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)}
              trigger={
                <>
                  <Mail className="size-4" /> Configure digest…
                </>
              }
            />
          </div>
        </section>

        <section className="mt-4 rounded-xl border bg-card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Server className="size-4" /> Server settings
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            SMTP, APP_URL, capture intervals, backups, and monitoring live in the deployment&apos;s environment —{" "}
            <a
              href="https://github.com/siaginw/sheetdiff#self-hosting-always-on"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              the README has the full table
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
