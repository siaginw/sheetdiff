import Link from "next/link";
import { GitCompareArrows, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { DigestSettingsDialog } from "@/components/sheet/digest-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/actions";
import type { User } from "@/lib/db/schema";

export function AppHeader({ user }: { user: User | null }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <GitCompareArrows className="size-4" />
          </span>
          SheetDiff
        </Link>
        {user ? (
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" render={<Link href="/sheets/new" />}>
              Add sheet
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="flex size-8 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-xs font-medium"
                    aria-label="Account menu"
                  >
                    {user.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.avatarUrl} alt="" className="size-8" />
                    ) : (
                      (user.name ?? user.email ?? "?").slice(0, 1).toUpperCase()
                    )}
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{user.name ?? "Signed in"}</div>
                  <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DigestSettingsDialog
                  digestEmail={user.digestEmail}
                  digestTime={user.digestTime ?? "07:00"}
                  digestDay={user.digestDay ?? null}
                />
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
          </div>
        ) : null}
      </div>
    </header>
  );
}
