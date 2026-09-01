"use client";

import { useState } from "react";
import { LogOut, Mail, UserPlus } from "lucide-react";
import { DigestSettingsDialog } from "@/components/sheet/digest-settings";
import { ShareDialog } from "@/components/sheet/share-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/actions";

/**
 * The account avatar menu + the dialogs it launches.
 *
 * The dialogs are rendered OUTSIDE the DropdownMenu subtree, driven by state:
 * a dialog mounted inside the menu content unmounts with the menu when the
 * item is clicked (the menu closes first) — it flashes open for ~200ms and
 * tears down, and on production builds never opens at all. The same class of
 * bug ate "Stop tracking…" in fleet 8; fleet 9 caught it surviving here.
 */
export function AccountMenu({
  name,
  email,
  avatarUrl,
  digestEmail,
  digestTime,
  digestDay,
  smtpReady,
  ownsSheets = true,
  members,
}: {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  digestEmail: string | null;
  digestTime: string;
  digestDay: number | null;
  smtpReady: boolean;
  /** true when this user owns at least one sheet — Share is an owner action */
  ownsSheets?: boolean;
  members: { id: string; email: string }[];
}) {
  const [digestOpen, setDigestOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="flex size-8 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-xs font-medium"
              aria-label="Account menu"
            >
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="size-8" />
              ) : (
                (name ?? email ?? "?").slice(0, 1).toUpperCase()
              )}
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium">{name ?? "Signed in"}</div>
            <div className="text-xs text-muted-foreground truncate">{email}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDigestOpen(true)}>
            <Mail /> Digest email…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={ownsSheets ? () => setShareOpen(true) : undefined}>
            <UserPlus /> {ownsSheets ? "Share access…" : "Shared with you"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <form action={logout} className="w-full">
              <button className="flex w-full items-center gap-2">
                <LogOut className="size-4" /> Sign out
              </button>
            </form>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DigestSettingsDialog
        open={digestOpen}
        onOpenChange={setDigestOpen}
        digestEmail={digestEmail}
        digestTime={digestTime}
        digestDay={digestDay}
        smtpReady={smtpReady}
      />
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} members={members} />
    </>
  );
}
